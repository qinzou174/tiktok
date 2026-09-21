const root = document.querySelector("#detailRoot");
const toast = document.querySelector("#toast");
const id = new URLSearchParams(location.search).get("id");
const IS_SUBPATH_DEPLOYMENT = /^\/shiguang(?:\/|$)/.test(location.pathname);
const API_BASE = String(window.APP_CONFIG?.apiBaseUrl || (IS_SUBPATH_DEPLOYMENT ? "/shiguang-api" : "")).replace(/\/$/, "");
const BASE_PATH = String(window.APP_CONFIG?.basePath || (IS_SUBPATH_DEPLOYMENT ? "/shiguang" : "")).replace(/\/$/, "");
let task = null;
let timer = null;

if (!id) showMissing("链接中缺少任务编号");
else loadTask();

root.addEventListener("click", async (event) => {
  const retry = event.target.closest("[data-retry]");
  if (!retry) return;
  try {
    const response = await fetch(apiUrl(`/api/tasks/${id}/retry`), { method: "POST" });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "重试失败");
    showToast("已重新加入队列");
    await loadTask();
  } catch (error) { showToast(error.message, true); }
});

async function loadTask() {
  try {
    const response = await fetch(apiUrl(`/api/tasks/${id}`), { cache: "no-store" });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "任务不存在");
    task = data;
    render();
    if (["queued", "resolving", "parsing", "downloading", "archiving", "retrying"].includes(task.status)) {
      clearTimeout(timer);
      timer = setTimeout(loadTask, 1200);
    }
  } catch (error) { showMissing(error.message); }
}

function render() {
  if (task.status !== "completed") return renderStatus();
  const result = task.result;
  const images = task.files.filter((file) => ["image", "cover"].includes(file.role));
  const video = task.files.find((file) => ["video", "live_video"].includes(file.role));
  const audio = task.files.find((file) => file.role === "audio");
  document.title = `${result.author} · 拾光`;
  root.innerHTML = `<section class="detail-hero">
    <div class="detail-sequence"><span>ARCHIVE / ${escapeHtml(String(task.naming?.sequence || 1).padStart(2, "0"))}</span><i></i><span>${escapeHtml(result.videoId || task.id.slice(0, 8))}</span></div>
    <div class="detail-heading"><div><div class="detail-meta"><span class="type-chip static">${typeLabel(result.type)}</span><span>${formatRemaining(task.expiresAt)}</span></div><h1>${escapeHtml(result.author)}</h1></div><span class="detail-glyph">↗</span></div>
    <p class="caption">${escapeHtml(result.title)}</p>
    <div class="quick-actions">${images.length ? `<a class="download-button primary" href="${apiUrl(`/api/tasks/${task.id}/photos.zip`)}" download><span>一键下载全部照片</span><small>${images.length} 张 · ZIP</small></a>` : ""}${task.files.map((file) => `<a class="download-button ${file.role === "video" || file.role === "live_video" ? "primary" : ""}" href="${fileUrl(file)}?download=1" download><span>${downloadLabel(file)}</span><small>${escapeHtml(file.filename)}</small></a>`).join("")}</div>
  </section>
  ${video ? `<section class="media-section"><div class="section-head compact"><div class="title-lockup"><div class="section-index"><span>01</span><i></i><span>MOTION</span></div><div><p class="eyebrow">本地视频</p><h2>${result.type === "live_photo" ? "实况动态" : "视频"}</h2></div></div><span>${formatBytes(video.size)}</span></div><div class="video-frame"><video controls playsinline preload="metadata" poster="${images[0] ? fileUrl(images[0]) : ""}" src="${fileUrl(video)}"></video><span class="frame-corner top"></span><span class="frame-corner bottom"></span></div></section>` : ""}
  ${images.length ? `<section class="media-section"><div class="section-head compact"><div class="title-lockup"><div class="section-index"><span>${video ? "02" : "01"}</span><i></i><span>STILLS</span></div><div><p class="eyebrow">本地图片</p><h2>${images.length > 1 ? `图集 · ${images.length} 张` : "照片"}</h2></div></div></div><div class="gallery ${images.length === 1 ? "single" : ""}">${images.map((file, index) => `<figure style="--card-order:${Math.min(index, 7)}"><img src="${fileUrl(file)}" alt="${escapeHtml(result.author)} 的图片 ${index + 1}" loading="lazy"><figcaption><span>${String(index + 1).padStart(2, "0")} / ${String(images.length).padStart(2, "0")}</span><a href="${fileUrl(file)}?download=1" download>下载原图 ↗</a></figcaption></figure>`).join("")}</div></section>` : ""}
  ${audio ? `<section class="audio-card"><div class="audio-index"><span>♪</span></div><div><p class="eyebrow">ORIGINAL SOUND</p><h2>作品音频</h2><small>${escapeHtml(audio.filename)}</small></div><audio controls preload="metadata" src="${fileUrl(audio)}"></audio><a href="${fileUrl(audio)}?download=1" download>下载 ↗</a></section>` : ""}
  <footer class="detail-footer"><span>创建于 ${formatDate(task.createdAt)}</span><span>将在 ${formatDate(task.expiresAt)} 自动清理</span></footer>`;
}

function renderStatus() {
  const failed = task.status === "failed";
  root.innerHTML = `<section class="status-page ${failed ? "is-failed" : ""}"><div class="status-orbit"><i></i><i></i><span>${failed ? "!" : ""}</span></div><p class="eyebrow">${failed ? "任务未完成" : "任务处理中"}</p><h1>${escapeHtml(task.progress)}</h1><p>${escapeHtml(failed ? task.error || "解析失败" : `后台正在处理第 ${task.attempt || 0} 次尝试，可以返回列表继续添加链接。`)}</p>${failed ? `<button class="retry-button large" data-retry><span>立即重试</span><b>↗</b></button>` : ""}</section>`;
}

function showMissing(message) { clearTimeout(timer); root.innerHTML = `<section class="status-page is-failed"><div class="status-orbit"><span>!</span></div><h1>${escapeHtml(message)}</h1><p>任务可能已经超过 24 小时并被自动清理。</p><a class="download-button primary" href="${BASE_PATH || "/"}">返回任务列表</a></section>`; }
function typeLabel(type) { return ({ video: "视频", image: "照片 / 图集", live_photo: "实况照片" })[type] || "未知类型"; }
function downloadLabel(file) { return ({ video: "下载视频", live_video: "下载实况视频", image: "下载照片", cover: "下载封面", audio: "下载音频" })[file.role] || "下载文件"; }
function apiUrl(path) { return `${API_BASE}${path}`; }
function fileUrl(file) { return apiUrl(`/api/tasks/${task.id}/files/${encodeURIComponent(file.filename)}`); }
function formatBytes(size) { if (size >= 1048576) return `${(size / 1048576).toFixed(1)} MB`; return `${Math.max(1, Math.round(size / 1024))} KB`; }
function formatDate(value) { return new Intl.DateTimeFormat("zh-CN", { month: "long", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(value)); }
function formatRemaining(expiresAt) { const diff = Date.parse(expiresAt) - Date.now(); const hours = Math.max(0, Math.floor(diff / 3600000)); const minutes = Math.max(0, Math.floor((diff % 3600000) / 60000)); return `${hours}小时${minutes}分后清理`; }
function escapeHtml(value = "") { return String(value).replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]); }
function showToast(message, error = false) { toast.textContent = message; toast.classList.toggle("error", error); toast.classList.add("show"); setTimeout(() => toast.classList.remove("show"), 2600); }
