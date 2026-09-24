const form = document.querySelector("#captureForm");
const input = document.querySelector("#urlInput");
const grid = document.querySelector("#taskGrid");
const empty = document.querySelector("#emptyState");
const queueStat = document.querySelector("#queueStat");
const systemStatus = document.querySelector("#systemStatus");
const activeMetric = document.querySelector("#activeMetric");
const queueMetric = document.querySelector("#queueMetric");
const toast = document.querySelector("#toast");
const IS_SUBPATH_DEPLOYMENT = /^\/shiguang(?:\/|$)/.test(location.pathname);
const API_BASE = String(window.APP_CONFIG?.apiBaseUrl || (IS_SUBPATH_DEPLOYMENT ? "/shiguang-api" : "")).replace(/\/$/, "");
const BASE_PATH = String(window.APP_CONFIG?.basePath || (IS_SUBPATH_DEPLOYMENT ? "/shiguang" : "")).replace(/\/$/, "");
let tasks = [];
let submitting = false;
const renderedSignatures = new Map();
let eventSource = null;
let reconnectTimer = null;
let autoSubmitTimer = null;

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  await submitText(input.value);
});

input.addEventListener("paste", (event) => {
  const pasted = event.clipboardData?.getData("text") || "";
  if (!/https?:\/\//i.test(pasted)) return;
  event.preventDefault();
  submitText(pasted);
});

// Some mobile browsers and system clipboard integrations do not expose
// clipboardData on the paste event. Detect a completed URL from the resulting
// input value as a fallback, without firing for every keystroke.
input.addEventListener("input", () => {
  clearTimeout(autoSubmitTimer);
  autoSubmitTimer = setTimeout(() => {
    if (/https?:\/\/[^\s]*(?:douyin\.com|iesdouyin\.com)\/\S*/i.test(input.value)) submitText(input.value);
  }, 400);
});

input.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    submitText(input.value);
  }
});

grid.addEventListener("click", (event) => {
  const button = event.target.closest("[data-retry]");
  if (button) {
    event.preventDefault();
    event.stopPropagation();
    retryTask(button.dataset.retry);
    return;
  }
  const card = event.target.closest("[data-task-id]");
  if (card) location.href = `${BASE_PATH}/task?id=${encodeURIComponent(card.dataset.taskId)}`;
});

grid.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" && event.key !== " ") return;
  const card = event.target.closest("[data-task-id]");
  if (!card || event.target.closest("button")) return;
  event.preventDefault();
  location.href = `${BASE_PATH}/task?id=${encodeURIComponent(card.dataset.taskId)}`;
});

async function submitText(text) {
  const clean = text.trim();
  if (!clean || submitting) return;
  submitting = true;
  clearTimeout(autoSubmitTimer);
  input.value = "";
  try {
    const response = await fetch(apiUrl("/api/tasks"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: clean }) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "创建任务失败");
    // 响应内为创建顺序（旧→新），反转后与全局“最新在前”排序一致，避免 SSE 快照到达时卡片跳动。
    tasks = [...data.tasks.slice().reverse(), ...tasks];
    render();
    showToast(`已创建 ${data.tasks.length} 个任务`);
  } catch (error) {
    input.value = clean;
    showToast(error.message, true);
  } finally {
    submitting = false;
    input.focus();
  }
}

async function retryTask(id) {
  try {
    const response = await fetch(apiUrl(`/api/tasks/${id}/retry`), { method: "POST" });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "重试失败");
    showToast("任务已重新加入队列");
    await refresh();
  } catch (error) { showToast(error.message, true); }
}

async function refresh() {
  try {
    const response = await fetch(apiUrl("/api/tasks"), { cache: "no-store" });
    if (!response.ok) throw new Error();
    const data = await response.json();
    tasks = data.tasks;
    render();
    const statusKey = `online:${data.activeWorkers}:${data.queued}`;
    if (systemStatus.dataset.state !== statusKey) {
      systemStatus.dataset.state = statusKey;
      systemStatus.innerHTML = `<span class="pulse"></span><span>${data.activeWorkers} 项处理中 · ${data.queued} 项排队</span>`;
    }
    setText(activeMetric, data.activeWorkers);
    setText(queueMetric, data.queued);
    systemStatus.classList.remove("offline");
  } catch {
    if (systemStatus.dataset.state !== "offline") {
      systemStatus.dataset.state = "offline";
      systemStatus.innerHTML = `<span class="pulse"></span><span>服务连接中断</span>`;
    }
    systemStatus.classList.add("offline");
  }
}

function connectEvents() {
  if (eventSource) eventSource.close();
  eventSource = new EventSource(apiUrl("/api/events"));
  eventSource.addEventListener("snapshot", (event) => {
    const data = JSON.parse(event.data);
    tasks = data.tasks;
    render();
    updateRuntime(data);
  });
  eventSource.addEventListener("task", (event) => {
    const task = JSON.parse(event.data);
    const index = tasks.findIndex((item) => item.id === task.id);
    if (index === -1) tasks = [task, ...tasks];
    else tasks[index] = task;
    tasks.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    render();
  });
  eventSource.addEventListener("task_expired", (event) => {
    const data = JSON.parse(event.data);
    tasks = tasks.filter((task) => task.id !== data.id);
    render();
  });
  eventSource.addEventListener("runtime", (event) => updateRuntime(JSON.parse(event.data)));
  eventSource.onopen = () => {
    systemStatus.classList.remove("offline");
    systemStatus.dataset.state = "sse:online";
    systemStatus.innerHTML = `<span class="pulse"></span><span>实时连接</span>`;
  };
  eventSource.onerror = () => {
    systemStatus.classList.add("offline");
    systemStatus.dataset.state = "sse:offline";
    systemStatus.innerHTML = `<span class="pulse"></span><span>实时重连中</span>`;
    eventSource.close();
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(async () => {
      await refresh();
      connectEvents();
    }, 5000);
  };
}

function updateRuntime(data) {
  const statusKey = `sse:${data.activeWorkers}:${data.queued}`;
  if (systemStatus.dataset.state !== statusKey && !systemStatus.dataset.state?.startsWith("sse:online")) {
    systemStatus.dataset.state = statusKey;
    systemStatus.innerHTML = `<span class="pulse"></span><span>${data.activeWorkers} 项处理中 · ${data.queued} 项排队</span>`;
  }
  setText(activeMetric, data.activeWorkers);
  setText(queueMetric, data.queued);
}

function render() {
  empty.hidden = tasks.length > 0;
  grid.hidden = tasks.length === 0;
  setText(queueStat, `${tasks.length} 个任务`);

  const currentIds = new Set(tasks.map((task) => task.id));
  for (const card of [...grid.querySelectorAll("[data-task-id]")]) {
    if (currentIds.has(card.dataset.taskId)) continue;
    renderedSignatures.delete(card.dataset.taskId);
    card.remove();
  }

  // 只触碰内容有变化或位置不对的卡片：对已有卡片调用 appendChild/insertBefore 会
  // 重新插入 DOM 节点并重放入场动画，导致整个列表反复“闪现”。移动前先加 no-enter
  // 禁用动画，保证已有卡片视觉上纹丝不动。
  tasks.forEach((task, index) => {
    const signature = taskSignature(task);
    let card = grid.querySelector(`[data-task-id="${CSS.escape(task.id)}"]`);
    if (!card) {
      card = cardElement(task, index, false);
      renderedSignatures.set(task.id, signature);
    } else if (renderedSignatures.get(task.id) !== signature) {
      const updated = cardElement(task, index, true);
      card.replaceWith(updated);
      card = updated;
      renderedSignatures.set(task.id, signature);
    }
    if (card !== grid.children[index]) {
      card.classList.add("no-enter");
      grid.insertBefore(card, grid.children[index] || null);
    }
  });

  for (const node of grid.querySelectorAll("[data-expires-at]")) {
    setText(node, formatRemaining(node.dataset.expiresAt));
  }
}

function cardElement(task, index, suppressEntrance) {
  const template = document.createElement("template");
  template.innerHTML = taskCard(task, index).trim();
  const card = template.content.firstElementChild;
  if (suppressEntrance) card.classList.add("no-enter");
  return card;
}

function taskSignature(task) {
  return JSON.stringify({
    status: task.status,
    progress: task.progress,
    attempt: task.attempt,
    error: task.error,
    result: task.result,
    files: task.files,
    expiresAt: task.expiresAt,
  });
}

function taskCard(task, index) {
  const result = task.result || {};
  const author = result.author || "正在识别 UP 主";
  const type = typeLabel(result.type);
  const completed = task.status === "completed";
  const failed = task.status === "failed";
  const processing = !completed && !failed;
  const image = task.files?.find((file) => ["image", "cover"].includes(file.role));
  const preview = image ? `<img src="${fileUrl(task, image)}" alt="" loading="lazy">` : `<div class="card-placeholder"><span>${processing ? "" : failed ? "!" : type.slice(0, 1)}</span><i></i><i></i></div>`;
  const remaining = formatRemaining(task.expiresAt);
  const stateText = completed ? `${task.files?.length || 0} FILES` : failed ? "FAILED" : `PASS ${String(task.attempt || 0).padStart(2, "0")}`;
  return `<article class="task-card ${escapeHtml(task.status)}" style="--card-order:${Math.min(index, 7)}" data-task-id="${escapeHtml(task.id)}" tabindex="0" role="link" aria-label="查看 ${escapeHtml(author)} 的任务">
    <div class="card-media">${preview}<div class="media-shade"></div><span class="type-chip">${escapeHtml(type)}</span><span class="card-code">${stateText}</span></div>
    <div class="card-body">
      <div class="card-title-row"><div><span class="card-kicker">CREATOR</span><h3>${escapeHtml(author)}</h3></div><span class="status-dot ${escapeHtml(task.status)}"></span></div>
      <p class="card-copy">${escapeHtml(completed ? result.title : task.progress || "等待处理")}</p>
      <div class="card-track"><i></i></div>
      <div class="card-footer"><span>${completed ? "已保存到本地" : failed ? escapeHtml(task.error || "任务失败") : "后台执行中"}</span><span data-expires-at="${escapeHtml(task.expiresAt)}">${remaining}</span></div>
      ${failed ? `<button class="retry-button" data-retry="${escapeHtml(task.id)}"><span>重新进入队列</span><b>↗</b></button>` : ""}
    </div>
  </article>`;
}

function typeLabel(type) { return ({ video: "视频", image: "照片 / 图集", live_photo: "实况照片" })[type] || "识别中"; }
function apiUrl(path) { return `${API_BASE}${path}`; }
function setText(element, value) { const text = String(value); if (element.textContent !== text) element.textContent = text; }
function fileUrl(task, file) { return apiUrl(`/api/tasks/${task.id}/files/${encodeURIComponent(file.filename)}`); }
function formatRemaining(expiresAt) {
  const diff = Date.parse(expiresAt) - Date.now();
  if (diff <= 0) return "即将清理";
  const hours = Math.floor(diff / 3600000);
  const minutes = Math.floor((diff % 3600000) / 60000);
  return hours ? `${hours}小时${minutes}分后清理` : `${Math.max(1, minutes)}分钟后清理`;
}
function escapeHtml(value = "") { return String(value).replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]); }
function showToast(message, error = false) { toast.textContent = message; toast.classList.toggle("error", error); toast.classList.add("show"); clearTimeout(showToast.timer); showToast.timer = setTimeout(() => toast.classList.remove("show"), 2600); }

refresh().then(connectEvents);
input.focus();
