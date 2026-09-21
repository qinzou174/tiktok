import http from "node:http";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, writeFile, readdir, rm, rename, stat } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { archivePathExists, archiveRelativePath, archiveWorkKey, safeArchiveName, writeArchive } from "./archive.mjs";
import { ApiRequestScheduler } from "./api-scheduler.mjs";
import { ApiCircuitBreaker } from "./api-circuit-breaker.mjs";
import { canonicalDouyinUrl } from "./douyin-url.mjs";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT, "public");
const DATA_DIR = path.join(ROOT, "data", "tasks");
const DATABASE_PATH = path.join(ROOT, "data", "naming.sqlite");
const API_ENDPOINT = "https://api.qzqi.com/api/v1/DouYinVideo";

await loadEnv(path.join(ROOT, ".env"));

const config = {
  apiKey: process.env.QZQI_API_KEY || "",
  host: process.env.HOST || "0.0.0.0",
  port: clampNumber(process.env.PORT, 4173, 1, 65535),
  concurrency: clampNumber(process.env.MAX_CONCURRENCY, 4, 1, 20),
  ttlMs: clampNumber(process.env.TASK_TTL_HOURS, 24, 1, 168) * 60 * 60 * 1000,
  maxRetries: clampNumber(process.env.MAX_RETRIES, 8, 1, 30),
  allowedOrigins: String(process.env.ALLOWED_ORIGINS || "").split(",").map((item) => item.trim()).filter(Boolean),
  archiveRoot: String(process.env.ARCHIVE_ROOT || "").trim(),
  circuitFailures: clampNumber(process.env.API_CIRCUIT_FAILURES, 3, 1, 20),
  circuitCooldownMs: clampNumber(process.env.API_CIRCUIT_COOLDOWN_SECONDS, 180, 10, 3600) * 1000,
};

if (!config.apiKey) {
  console.error("缺少 QZQI_API_KEY，请在 .env 中填写。 ");
  process.exit(1);
}

await mkdir(DATA_DIR, { recursive: true });

const database = new DatabaseSync(DATABASE_PATH);
database.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  CREATE TABLE IF NOT EXISTS author_sequences (
    author TEXT PRIMARY KEY COLLATE NOCASE,
    last_sequence INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS task_names (
    task_id TEXT PRIMARY KEY,
    author TEXT NOT NULL COLLATE NOCASE,
    sequence INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE(author, sequence)
  );
  CREATE TABLE IF NOT EXISTS archive_author_sequences (
    author TEXT PRIMARY KEY COLLATE NOCASE,
    last_sequence INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS archive_records (
    work_key TEXT PRIMARY KEY,
    author TEXT NOT NULL COLLATE NOCASE,
    sequence INTEGER NOT NULL,
    folder_name TEXT NOT NULL,
    relative_path TEXT NOT NULL,
    task_id TEXT NOT NULL,
    status TEXT NOT NULL,
    error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(author, sequence)
  );
`);
normalizeStoredAuthors();

const tasks = new Map();
const queue = [];
const retryQueue = [];
const queuedIds = new Set();
const retryTimers = new Map();
const sseClients = new Set();
const archiveInflight = new Map();
let activeWorkers = 0;
let lastAccessAt = 0;
const parserScheduler = new ApiRequestScheduler({
  execute: callParserRequest,
  minIntervalMs: 1_000,
  onStateChange: () => broadcast("runtime", runtimeState()),
});
const apiCircuit = new ApiCircuitBreaker({
  failureThreshold: config.circuitFailures,
  cooldownMs: config.circuitCooldownMs,
  onStateChange: (state) => {
    console.warn(`[api-circuit] status=${state.status} failures=${state.failures} open_until=${state.openUntil || "-"}`);
    broadcast("runtime", runtimeState());
  },
});

await restoreTasks();
await cleanupExpired();
await migrateExistingTaskNames();

const server = http.createServer(async (req, res) => {
  try {
    await route(req, res);
  } catch (error) {
    const status = Number.isInteger(error?.status) ? error.status : 500;
    if (status >= 500) console.error(error);
    sendJson(res, status, { error: status < 500 ? cleanError(error) : "服务器内部错误" });
  }
});

server.listen(config.port, config.host, () => {
  console.log(`抖音解析台已启动：http://${config.host}:${config.port}`);
  console.log(`并发任务数：${config.concurrency}，任务保留：${config.ttlMs / 3600000} 小时`);
});

setInterval(() => { if (tasks.size) cleanupExpired(); }, 60_000).unref();

async function route(req, res) {
  lastAccessAt = Date.now();
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const isApi = url.pathname.startsWith("/api/");
  if (isApi) applyCors(req, res);

  if (req.method === "OPTIONS" && isApi) {
    res.writeHead(204);
    return res.end();
  }

  if (req.method === "GET" && url.pathname === "/api/health") {
    return sendJson(res, 200, runtimeState({ ok: true, concurrency: config.concurrency }));
  }

  if (req.method === "GET" && url.pathname === "/api/events") {
    return openEventStream(req, res);
  }

  if (req.method === "GET" && url.pathname === "/api/tasks") {
    const visible = [...tasks.values()]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map(publicTask);
    return sendJson(res, 200, { tasks: visible, ...runtimeState() });
  }

  if (req.method === "POST" && url.pathname === "/api/tasks") {
    const body = await readJsonBody(req);
    const urls = extractUrls(String(body.text || body.url || "")).filter(isSupportedDouyinUrl);
    if (!urls.length) return sendJson(res, 400, { error: "没有找到有效链接" });
    const created = [];
    for (const sourceUrl of urls) created.push(await createTask(sourceUrl));
    pumpQueue();
    return sendJson(res, 202, { tasks: created.map(publicTask) });
  }

  const retryMatch = url.pathname.match(/^\/api\/tasks\/([a-f0-9-]+)\/retry$/i);
  if (req.method === "POST" && retryMatch) {
    const task = tasks.get(retryMatch[1]);
    if (!task) return sendJson(res, 404, { error: "任务不存在或已过期" });
    if (["queued", "resolving", "parsing", "downloading", "archiving", "retrying"].includes(task.status)) {
      return sendJson(res, 409, { error: "任务仍在执行" });
    }
    task.status = "queued";
    task.error = null;
    task.attempt = 0;
    task.progress = "等待重新解析";
    task.updatedAt = new Date().toISOString();
    await persistTask(task);
    enqueueTask(task, "retry");
    pumpQueue();
    return sendJson(res, 202, publicTask(task));
  }

  const taskMatch = url.pathname.match(/^\/api\/tasks\/([a-f0-9-]+)$/i);
  if (req.method === "GET" && taskMatch) {
    const task = tasks.get(taskMatch[1]);
    if (!task) return sendJson(res, 404, { error: "任务不存在或已过期" });
    return sendJson(res, 200, publicTask(task));
  }

  const photosMatch = url.pathname.match(/^\/api\/tasks\/([a-f0-9-]+)\/photos\.zip$/i);
  if (req.method === "GET" && photosMatch) {
    const task = tasks.get(photosMatch[1]);
    if (!task) return sendJson(res, 404, { error: "任务不存在或已过期" });
    return servePhotosZip(res, task);
  }

  const fileMatch = url.pathname.match(/^\/api\/tasks\/([a-f0-9-]+)\/files\/([^/]+)$/i);
  if (req.method === "GET" && fileMatch) {
    const task = tasks.get(fileMatch[1]);
    if (!task) return sendJson(res, 404, { error: "任务不存在或已过期" });
    const file = task.files?.find((item) => item.filename === decodeURIComponent(fileMatch[2]));
    if (!file) return sendJson(res, 404, { error: "文件不存在" });
    return serveTaskFile(req, res, task, file, url.searchParams.has("download"));
  }

  return serveStatic(url.pathname, res);
}

async function createTask(sourceUrl) {
  const now = new Date();
  const task = {
    id: randomUUID(), sourceUrl, normalizedUrl: null, status: "queued", progress: "等待解析",
    attempt: 0, maxRetries: config.maxRetries, createdAt: now.toISOString(), updatedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + config.ttlMs).toISOString(), error: null, result: null, files: [],
  };
  tasks.set(task.id, task);
  await mkdir(taskDir(task.id), { recursive: true });
  await persistTask(task);
  broadcast("task", publicTask(task));
  enqueueTask(task, "fresh");
  return task;
}

function enqueueTask(task, kind = "fresh") {
  if (!task || task.status !== "queued" || queuedIds.has(task.id)) return false;
  (kind === "retry" ? retryQueue : queue).push(task.id);
  queuedIds.add(task.id);
  broadcast("runtime", runtimeState());
  return true;
}

function pumpQueue() {
  while (activeWorkers < config.concurrency) {
    let kind = "fresh";
    let id = queue.shift();
    if (!id) {
      // Failed work is deliberately paused until every first-pass task and
      // its download/archive stage has finished. Retries then run one by one.
      if (activeWorkers > 0 || !retryQueue.length) break;
      kind = "retry";
      id = retryQueue.shift();
    }
    queuedIds.delete(id);
    const task = tasks.get(id);
    if (!task || task.status !== "queued") continue;
    activeWorkers += 1;
    broadcast("runtime", runtimeState());
    processTaskAttempt(task, kind).catch(console.error).finally(() => {
      activeWorkers -= 1;
      broadcast("runtime", runtimeState());
      pumpQueue();
    });
  }
}

async function processTaskAttempt(task, queueKind) {
  const attempt = Number(task.attempt || 0) + 1;
  task.attempt = attempt;
  let failureStage = task.retryStage === "media" && task.result ? "media" : "parse";
  try {
    if (failureStage === "parse") {
      await updateTask(task, { status: "resolving", progress: "正在识别分享链接", error: null, nextRetryAt: null });
      task.normalizedUrl = await normalizeDouyinUrl(task.sourceUrl);
      await updateTask(task, { status: "parsing", progress: `正在解析（第 ${attempt} 次）` });
    const data = await parserScheduler.schedule(task.normalizedUrl, queueKind);
      task._rawApi = data;
      task.result = normalizeResult(data);
      validateParsedResult(task.result);
      task.naming = reserveAuthorSequence(task.id, task.result.author, task.createdAt);
      failureStage = "media";
      task.retryStage = "media";
    }
    await updateTask(task, { status: "downloading", progress: "正在保存媒体到本地" });
    task.files = await downloadAll(task, task.result);
    await updateTask(task, { status: "archiving", progress: "正在归档到家庭云 NAS" });
    task.archive = await archiveTask(task);
    await updateTask(task, { status: "completed", progress: "已完成", error: null, nextRetryAt: null, retryStage: null });
    console.info(`[task:${task.id}] completed attempt=${attempt} type=${task.result?.type || "unknown"} author=${task.result?.author || "unknown"}`);
  } catch (error) {
    const retryable = isRetryable(error);
    const circuitPaused = error?.code === "API_CIRCUIT_OPEN";
    if (circuitPaused) task.attempt = Math.max(0, attempt - 1);
    if (!retryable || (!circuitPaused && attempt >= config.maxRetries)) {
      await updateTask(task, { status: "failed", progress: failureStage === "media" ? "保存失败" : "解析失败", error: cleanError(error), nextRetryAt: null, retryStage: failureStage });
      console.error(`[task:${task.id}] failed attempt=${attempt} error=${cleanError(error)}`);
      return;
    }
    const backoffMs = Math.min(60_000, 2_000 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 800);
    const delayMs = circuitPaused ? Math.max(backoffMs, Number(error.retryAfterMs || 0)) : backoffMs;
    const nextRetryAt = new Date(Date.now() + delayMs).toISOString();
    await updateTask(task, {
      status: "retrying",
      progress: `${circuitPaused ? "远梦服务熔断暂停" : failureStage === "media" ? "保存暂时失败" : "解析暂时失败"}，${Math.ceil(delayMs / 1000)} 秒后进入重试队列`,
      error: cleanError(error),
      nextRetryAt,
      retryStage: failureStage,
    });
    console.warn(`[task:${task.id}] retry_scheduled attempt=${attempt} delay_ms=${delayMs} error=${cleanError(error)}`);
    scheduleRetry(task, delayMs);
  }
}

function scheduleRetry(task, delayMs) {
  const previous = retryTimers.get(task.id);
  if (previous) clearTimeout(previous);
  const timer = setTimeout(async () => {
    try {
      retryTimers.delete(task.id);
      if (!tasks.has(task.id) || task.status !== "retrying") return;
      await updateTask(task, { status: "queued", progress: `等待第 ${Number(task.attempt || 0) + 1} 次尝试` });
      enqueueTask(task, "retry");
      pumpQueue();
    } catch (error) {
      console.error(`[task:${task.id}] retry_enqueue_failed error=${cleanError(error)}`);
    }
  }, Math.max(0, delayMs));
  timer.unref();
  retryTimers.set(task.id, timer);
  broadcast("runtime", runtimeState());
}

function runtimeState(extra = {}) {
  return {
    ...extra,
    activeWorkers,
    queued: queue.length + retryQueue.length,
    freshQueued: queue.length,
    retryQueued: retryQueue.length,
    delayedRetries: retryTimers.size,
    apiCallActive: parserScheduler.active,
    apiFreshWaiting: parserScheduler.fresh.length,
    apiRetryWaiting: parserScheduler.retry.length,
    apiCircuit: apiCircuit.state(),
  };
}

async function archiveTask(task) {
  if (!config.archiveRoot) return { status: "disabled" };
  const workKey = archiveWorkKey(task);
  if (archiveInflight.has(workKey)) return archiveInflight.get(workKey);
  const promise = archiveTaskOnce(task, workKey).finally(() => archiveInflight.delete(workKey));
  archiveInflight.set(workKey, promise);
  return promise;
}

async function archiveTaskOnce(task, workKey) {
  const record = reserveArchiveRecord(task, workKey);
  if (record.status === "complete" && await archivePathExists(config.archiveRoot, record.relativePath)) {
    return { status: "existing", workKey, author: record.author, sequence: record.sequence, relativePath: record.relativePath };
  }
  try {
    const result = await writeArchive({
      root: config.archiveRoot,
      task: { ...task, directory: taskDir(task.id) },
      rawApi: task._rawApi,
      record,
    });
    markArchiveRecord(workKey, "complete", null);
    return result;
  } catch (error) {
    markArchiveRecord(workKey, "failed", cleanError(error));
    throw retryableError(`NAS 归档失败：${error.message}`);
  }
}

function reserveArchiveRecord(task, workKey) {
  const existing = database.prepare("SELECT * FROM archive_records WHERE work_key = ?").get(workKey);
  const now = new Date().toISOString();
  if (existing) {
    database.prepare("UPDATE archive_records SET task_id = ?, status = 'pending', error = NULL, updated_at = ? WHERE work_key = ? AND status != 'complete'").run(task.id, now, workKey);
    return { ...existing, workKey, folderName: existing.folder_name, relativePath: existing.relative_path };
  }

  const author = normalizeAuthor(task.result?.author);
  database.exec("BEGIN IMMEDIATE");
  try {
    database.prepare("INSERT INTO archive_author_sequences (author, last_sequence, updated_at) VALUES (?, 0, ?) ON CONFLICT(author) DO NOTHING").run(author, now);
    database.prepare("UPDATE archive_author_sequences SET last_sequence = last_sequence + 1, updated_at = ? WHERE author = ?").run(now, author);
    const sequence = database.prepare("SELECT last_sequence FROM archive_author_sequences WHERE author = ?").get(author).last_sequence;
    let folderName = safeArchiveName(author);
    const collision = database.prepare("SELECT author FROM archive_records WHERE folder_name = ? AND author != ? LIMIT 1").get(folderName, author);
    if (collision) folderName = `${folderName}-${workKey.replace(/[^a-z0-9]/gi, "").slice(-6)}`;
    const relativePath = archiveRelativePath(author, sequence, folderName);
    database.prepare(`INSERT INTO archive_records
      (work_key, author, sequence, folder_name, relative_path, task_id, status, error, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'pending', NULL, ?, ?)`
    ).run(workKey, author, sequence, folderName, relativePath, task.id, now, now);
    database.exec("COMMIT");
    return { workKey, author, sequence, folderName, relativePath, status: "pending" };
  } catch (error) {
    database.exec("ROLLBACK");
    const concurrent = database.prepare("SELECT * FROM archive_records WHERE work_key = ?").get(workKey);
    if (concurrent) return { ...concurrent, workKey, folderName: concurrent.folder_name, relativePath: concurrent.relative_path };
    throw error;
  }
}

function markArchiveRecord(workKey, status, error) {
  database.prepare("UPDATE archive_records SET status = ?, error = ?, updated_at = ? WHERE work_key = ?")
    .run(status, error, new Date().toISOString(), workKey);
}

async function normalizeDouyinUrl(source) {
  const extracted = extractUrls(source)[0];
  if (!extracted) throw permanentError("未找到抖音链接");
  let current = extracted.replaceAll("\\_", "_");
  const parsed = new URL(current);
  if (!/(^|\.)douyin\.com$/i.test(parsed.hostname) && !/(^|\.)iesdouyin\.com$/i.test(parsed.hostname)) {
    throw permanentError("目前只支持抖音链接");
  }
  try {
    const response = await fetch(current, {
      redirect: "follow",
      signal: AbortSignal.timeout(20_000),
      headers: { "user-agent": browserAgent() },
    });
    const finalUrl = response.url || current;
    await response.body?.cancel();
    return canonicalDouyinUrl(finalUrl);
  } catch (error) {
    if (/v\.douyin\.com|iesdouyin\.com/i.test(current)) throw retryableError(`分享链接跳转失败：${error.message}`);
    return current;
  }
}

async function callParserRequest(url) {
  apiCircuit.beforeRequest();
  const apiUrl = new URL(API_ENDPOINT);
  apiUrl.searchParams.set("url", url);
  let response;
  try {
    response = await fetch(apiUrl, {
      signal: AbortSignal.timeout(35_000),
      headers: { accept: "application/json", authorization: `Bearer ${config.apiKey}` },
    });
  } catch (error) {
    apiCircuit.infrastructureFailure();
    throw retryableError(`解析接口连接失败：${error.message}`);
  }
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch {
    apiCircuit.infrastructureFailure();
    throw retryableError(`解析接口返回了无效内容（HTTP ${response.status}）`);
  }
  if (!response.ok) {
    if (response.status >= 500) apiCircuit.infrastructureFailure();
    else apiCircuit.success();
    throw retryableError(data.message || `解析接口 HTTP ${response.status}`);
  }
  if (data.success !== true) {
    const message = String(data.message || "解析失败");
    if (isParserInfrastructureFailure(message)) apiCircuit.infrastructureFailure();
    else apiCircuit.success();
    if (/无法识别|不支持|无效链接|不存在/.test(message)) throw permanentError(message);
    throw retryableError(message);
  }
  apiCircuit.success();
  return data;
}

function isParserInfrastructureFailure(message) {
  return /failed to connect|failed to connecting|connection.*(?:timed out|refused|reset)|timeout|timed out|upstream|bad gateway|service unavailable/i.test(String(message));
}

function normalizeResult(data) {
  const images = toArray(data.images);
  const cleanImages = toArray(data.images_no_watermark);
  return {
    type: data.type || "unknown", videoId: String(data.video_id || ""), title: data.title || "未命名作品",
    author: data.author || data.author_info?.nickname || "未知作者", authorInfo: data.author_info || null,
    coverUrl: data.cover_url || null, audioUrl: data.audio_url || null,
    videoUrl: data.video_url || null, videoUrlHd: data.video_url_hd || null,
    images, cleanImages,
  };
}

function validateParsedResult(result) {
  if (!result.videoId) throw retryableError("解析接口未返回作品 ID");
  if (!result.author || result.author === "未知作者") throw retryableError("解析接口未返回作者信息");
  const hasMedia = Boolean(result.videoUrlHd || result.videoUrl || result.audioUrl || result.coverUrl || result.images.length || result.cleanImages.length);
  if (!hasMedia) throw retryableError("解析接口未返回有效媒体地址");
}

async function downloadAll(task, result) {
  const candidates = [];
  const imageUrls = result.cleanImages.length ? result.cleanImages : result.images;
  imageUrls.forEach((url, index) => candidates.push({ role: "image", url, index }));
  if (result.type === "video" && (result.videoUrlHd || result.videoUrl)) {
    candidates.push({ role: "video", url: result.videoUrlHd || result.videoUrl, index: 0 });
  }
  if (result.type === "live_photo" && (result.videoUrlHd || result.videoUrl)) {
    candidates.push({ role: "live_video", url: result.videoUrlHd || result.videoUrl, index: 0 });
  }
  if (result.audioUrl) candidates.push({ role: "audio", url: result.audioUrl, index: 0 });
  if (result.coverUrl && !imageUrls.length) candidates.push({ role: "cover", url: result.coverUrl, index: 0 });

  const saved = [];
  let completed = 0;
  const workerCount = Math.min(3, Math.max(1, candidates.length));
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (candidates.length) {
      const item = candidates.shift();
      const file = await downloadResource(task, item);
      saved.push(file);
      completed += 1;
      await updateTask(task, { progress: `正在保存媒体 ${completed}/${completed + candidates.length}` }, false);
    }
  }));
  return saved.sort((a, b) => a.role.localeCompare(b.role) || a.index - b.index);
}

async function downloadResource(task, item) {
  let response;
  try {
    response = await fetch(item.url, { redirect: "follow", signal: AbortSignal.timeout(120_000), headers: { "user-agent": browserAgent() } });
  } catch (error) {
    throw retryableError(`媒体下载超时：${error.message}`);
  }
  if (!response.ok || !response.body) throw retryableError(`媒体下载失败：HTTP ${response.status}`);
  const contentType = response.headers.get("content-type")?.split(";")[0] || "application/octet-stream";
  const extension = extensionFor(contentType, item.url, item.role);
  const filename = mediaFilename(task.naming, item, extension);
  const finalPath = path.join(taskDir(task.id), filename);
  const tempPath = `${finalPath}.part`;
  try {
    await pipeline(response.body, createWriteStream(tempPath));
    await rename(tempPath, finalPath);
    const info = await stat(finalPath);
    return { role: item.role, index: item.index, filename, contentType, size: info.size };
  } catch (error) {
    await rm(tempPath, { force: true });
    throw retryableError(`保存媒体失败：${error.message}`);
  }
}

function reserveAuthorSequence(taskId, rawAuthor, createdAt) {
  const existing = database.prepare("SELECT author, sequence FROM task_names WHERE task_id = ?").get(taskId);
  if (existing) return { author: existing.author, sequence: existing.sequence, base: authorFileBase(existing.author, existing.sequence) };

  const author = normalizeAuthor(rawAuthor);
  const now = new Date().toISOString();
  database.exec("BEGIN IMMEDIATE");
  try {
    database.prepare(`
      INSERT INTO author_sequences (author, last_sequence, updated_at)
      VALUES (?, 0, ?)
      ON CONFLICT(author) DO NOTHING
    `).run(author, now);
    database.prepare("UPDATE author_sequences SET last_sequence = last_sequence + 1, updated_at = ? WHERE author = ?").run(now, author);
    const row = database.prepare("SELECT last_sequence FROM author_sequences WHERE author = ?").get(author);
    database.prepare("INSERT INTO task_names (task_id, author, sequence, created_at) VALUES (?, ?, ?, ?)").run(taskId, author, row.last_sequence, createdAt || now);
    database.exec("COMMIT");
    return { author, sequence: row.last_sequence, base: authorFileBase(author, row.last_sequence) };
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function mediaFilename(naming, item, extension) {
  const base = naming?.base || authorFileBase("未知作者", 1);
  // The author sequence identifies the work. Extra photos need unique paths,
  // but their label must not look like a new work sequence.
  const itemSuffix = item.role === "image" && item.index > 0 ? `-照片${item.index + 1}` : "";
  return `${base}${itemSuffix}.${extension}`;
}

function normalizeAuthor(value) {
  const author = String(value || "未知作者")
    .trim()
    .replace(/\s+/g, " ")
    .replace(/[.。．·・… ]+$/g, "");
  return author || "未知作者";
}

function authorFileBase(author, sequence) {
  let safe = normalizeAuthor(author)
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .replace(/[. ]+$/g, "")
    .slice(0, 80);
  if (!safe) safe = "未知作者";
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(safe)) safe = `_${safe}`;
  return sequence > 1 ? `${safe}.${sequence}` : safe;
}

function normalizeStoredAuthors() {
  const rows = database.prepare("SELECT task_id, author, created_at FROM task_names ORDER BY created_at, rowid").all();
  if (!rows.some((row) => normalizeAuthor(row.author) !== row.author)) return;

  database.exec("BEGIN IMMEDIATE");
  try {
    database.exec("DELETE FROM task_names; DELETE FROM author_sequences;");
    const counts = new Map();
    const insertTask = database.prepare("INSERT INTO task_names (task_id, author, sequence, created_at) VALUES (?, ?, ?, ?)");
    for (const row of rows) {
      const author = normalizeAuthor(row.author);
      const sequence = (counts.get(author) || 0) + 1;
      counts.set(author, sequence);
      insertTask.run(row.task_id, author, sequence, row.created_at);
    }
    const insertAuthor = database.prepare("INSERT INTO author_sequences (author, last_sequence, updated_at) VALUES (?, ?, ?)");
    const now = new Date().toISOString();
    for (const [author, sequence] of counts) insertAuthor.run(author, sequence, now);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

async function updateTask(task, patch, persist = true) {
  Object.assign(task, patch, { updatedAt: new Date().toISOString() });
  if (persist) await persistTask(task);
  broadcast("task", publicTask(task));
}

async function persistTask(task) {
  const target = path.join(taskDir(task.id), "task.json");
  const temp = `${target}.tmp`;
  await mkdir(taskDir(task.id), { recursive: true });
  await writeFile(temp, JSON.stringify(task, null, 2), "utf8");
  await rename(temp, target);
}

async function restoreTasks() {
  for (const entry of await readdir(DATA_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    try {
      const task = JSON.parse(await readFile(path.join(DATA_DIR, entry.name, "task.json"), "utf8"));
      if (Date.parse(task.expiresAt) <= Date.now()) continue;
      tasks.set(task.id, task);
      if (task.status === "retrying" && Date.parse(task.nextRetryAt) > Date.now()) {
        scheduleRetry(task, Date.parse(task.nextRetryAt) - Date.now());
      } else if (["queued", "resolving", "parsing", "downloading", "archiving", "retrying"].includes(task.status)) {
        task.status = "queued";
        task.progress = "服务重启，继续任务";
        enqueueTask(task, Number(task.attempt || 0) > 0 ? "retry" : "fresh");
      }
    } catch (error) {
      console.warn(`跳过损坏任务 ${entry.name}: ${error.message}`);
    }
  }
  pumpQueue();
}

async function migrateExistingTaskNames() {
  const completed = [...tasks.values()]
    .filter((task) => task.status === "completed" && task.result?.author && task.files?.length)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  for (const task of completed) {
    const naming = reserveAuthorSequence(task.id, task.result.author, task.createdAt);
    const namingChanged = task.naming?.author !== naming.author || task.naming?.sequence !== naming.sequence || task.naming?.base !== naming.base;
    const updatedFiles = [];
    let changed = false;
    for (const file of task.files) {
      const extension = path.extname(file.filename).replace(/^\./, "") || extensionFor(file.contentType, "", file.role);
      const wanted = mediaFilename(naming, file, extension);
      if (wanted !== file.filename) {
        const oldPath = path.join(taskDir(task.id), file.filename);
        const newPath = path.join(taskDir(task.id), wanted);
        try {
          await rename(oldPath, newPath);
          changed = true;
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
      }
      updatedFiles.push({ ...file, filename: wanted });
    }
    if (changed || namingChanged) {
      task.naming = naming;
      task.files = updatedFiles;
      await persistTask(task);
    }
  }
}

async function cleanupExpired() {
  const now = Date.now();
  for (const [id, task] of tasks) {
    if (Date.parse(task.expiresAt) > now) continue;
    tasks.delete(id);
    const retryTimer = retryTimers.get(id);
    if (retryTimer) clearTimeout(retryTimer);
    retryTimers.delete(id);
    const queuedIndex = queue.indexOf(id);
    if (queuedIndex >= 0) queue.splice(queuedIndex, 1);
    const retryQueuedIndex = retryQueue.indexOf(id);
    if (retryQueuedIndex >= 0) retryQueue.splice(retryQueuedIndex, 1);
    queuedIds.delete(id);
    await rm(taskDir(id), { recursive: true, force: true });
    broadcast("task_expired", { id });
  }
  for (const entry of await readdir(DATA_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory() || tasks.has(entry.name)) continue;
    try {
      const info = await stat(path.join(DATA_DIR, entry.name));
      if (now - info.birthtimeMs > config.ttlMs) await rm(path.join(DATA_DIR, entry.name), { recursive: true, force: true });
    } catch {}
  }
}

function openEventStream(req, res) {
  applyCors(req, res);
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-store, must-revalidate",
    "connection": "keep-alive",
    "x-accel-buffering": "no",
  });
  const client = { res, heartbeat: null };
  sseClients.add(client);
  writeEvent(client, "snapshot", eventSnapshot());
  client.heartbeat = setInterval(() => {
    try { res.write(": heartbeat\n\n"); } catch { closeEventClient(client); }
  }, 20_000);
  req.on("close", () => closeEventClient(client));
}

function eventSnapshot() {
  return {
    tasks: [...tasks.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(publicTask),
    ...runtimeState(),
  };
}

function broadcast(event, data) {
  for (const client of sseClients) writeEvent(client, event, data);
}

function writeEvent(client, event, data) {
  try {
    client.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  } catch { closeEventClient(client); }
}

function closeEventClient(client) {
  if (!sseClients.delete(client)) return;
  if (client.heartbeat) clearInterval(client.heartbeat);
  try { client.res.end(); } catch {}
}

async function serveTaskFile(req, res, task, file, download) {
  const filePath = path.join(taskDir(task.id), file.filename);
  const info = await stat(filePath);
  const range = req.headers.range;
  const disposition = `${download ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(file.filename)}`;
  if (range) {
    const match = range.match(/bytes=(\d*)-(\d*)/);
    if (!match) {
      res.setHeader("content-range", `bytes */${info.size}`);
      return sendText(res, 416, "Invalid range");
    }
    const suffixLength = !match[1] && match[2] ? Number(match[2]) : null;
    const start = suffixLength !== null ? Math.max(0, info.size - suffixLength) : Number(match[1] || 0);
    const end = suffixLength !== null ? info.size - 1 : match[2] ? Math.min(Number(match[2]), info.size - 1) : info.size - 1;
    if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= info.size) {
      res.setHeader("content-range", `bytes */${info.size}`);
      return sendText(res, 416, "Range not satisfiable");
    }
    res.writeHead(206, { "content-type": file.contentType, "content-length": end - start + 1, "content-range": `bytes ${start}-${end}/${info.size}`, "accept-ranges": "bytes", "content-disposition": disposition, "cache-control": "private, max-age=3600" });
    return createReadStream(filePath, { start, end }).pipe(res);
  }
  res.writeHead(200, { "content-type": file.contentType, "content-length": info.size, "accept-ranges": "bytes", "content-disposition": disposition, "cache-control": "private, max-age=3600" });
  createReadStream(filePath).pipe(res);
}

async function servePhotosZip(res, task) {
  const photos = (task.files || []).filter((file) => ["image", "cover"].includes(file.role));
  if (!photos.length) return sendJson(res, 404, { error: "该作品没有可下载的照片" });
  const entries = [];
  for (const file of photos) {
    entries.push({ name: file.filename, data: await readFile(path.join(taskDir(task.id), file.filename)) });
  }
  const archive = createZip(entries);
  const base = task.naming?.base || authorFileBase(task.result?.author || "未知作者", task.naming?.sequence || 1);
  const filename = `${base}-全部照片.zip`;
  res.writeHead(200, {
    "content-type": "application/zip",
    "content-length": archive.length,
    "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
    "cache-control": "private, no-store",
  });
  res.end(archive);
}

function createZip(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const crc = crc32(entry.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(entry.data.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    localParts.push(local, name, entry.data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(entry.data.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);
    offset += local.length + name.length + entry.data.length;
  }
  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

const CRC32_TABLE = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
  return value >>> 0;
});

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC32_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

async function serveStatic(pathname, res) {
  const routes = { "/": "index.html", "/index.html": "index.html", "/task": "task.html", "/task.html": "task.html" };
  const requested = routes[pathname] || pathname.replace(/^\//, "");
  const safePath = path.normalize(requested).replace(/^(\.\.(\/|\\|$))+/, "");
  const filePath = path.join(PUBLIC_DIR, safePath);
  if (!filePath.startsWith(PUBLIC_DIR)) return sendText(res, 403, "Forbidden");
  try {
    const content = await readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    const types = {
      ".html": "text/html; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
      ".svg": "image/svg+xml",
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".webp": "image/webp",
      ".gif": "image/gif",
      ".ico": "image/x-icon",
    };
    res.writeHead(200, { "content-type": types[ext] || "application/octet-stream", "cache-control": "no-cache" });
    res.end(content);
  } catch { sendText(res, 404, "Not found"); }
}

function publicTask(task) {
  const { _rawApi, ...visible } = task;
  return visible;
}

function extractUrls(text) {
  const matches = text.match(/https?:\/\/[^\s<>\]）】]+/gi) || [];
  return [...new Set(matches.map((url) => url.replace(/[，。！？、；：'"）)\]}]+$/g, "").replaceAll("\\_", "_")))];
}

function isSupportedDouyinUrl(value) {
  try {
    const hostname = new URL(value).hostname;
    return /(^|\.)douyin\.com$/i.test(hostname) || /(^|\.)iesdouyin\.com$/i.test(hostname);
  } catch { return false; }
}

function toArray(value) {
  if (!value) return [];
  return (Array.isArray(value) ? value : [value]).filter((item) => typeof item === "string" && item.startsWith("http"));
}

function extensionFor(contentType, url, role) {
  const map = { "video/mp4": "mp4", "audio/mpeg": "mp3", "audio/mp4": "m4a", "image/jpeg": "jpg", "image/webp": "webp", "image/png": "png", "image/gif": "gif" };
  if (map[contentType]) return map[contentType];
  try { const ext = path.extname(new URL(url).pathname).replace(".", ""); if (/^[a-z0-9]{2,5}$/i.test(ext)) return ext; } catch {}
  return role.includes("video") ? "mp4" : role === "audio" ? "mp3" : "bin";
}

function isRetryable(error) { return error?.retryable !== false; }
function retryableError(message) { const error = new Error(message); error.retryable = true; return error; }
function permanentError(message, status) { const error = new Error(message); error.retryable = false; if (status) error.status = status; return error; }
function cleanError(error) { return String(error?.message || error || "未知错误").slice(0, 500); }
function taskDir(id) { return path.join(DATA_DIR, id); }
function browserAgent() { return "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0 Safari/537.36"; }
function clampNumber(value, fallback, min, max) { const number = Number(value); return Number.isFinite(number) ? Math.min(max, Math.max(min, Math.round(number))) : fallback; }

async function loadEnv(filePath) {
  try {
    const content = await readFile(filePath, "utf8");
    for (const line of content.split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
      if (match && process.env[match[1]] === undefined) process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, "");
    }
  } catch {}
}

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1_000_000) throw permanentError("请求内容过大", 413);
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); }
  catch { throw permanentError("请求格式无效", 400); }
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(body), "cache-control": "no-store" });
  res.end(body);
}

function sendText(res, status, text) {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
  res.end(text);
}

function applyCors(req, res) {
  const origin = req.headers.origin;
  if (!origin) return;
  const allowed = config.allowedOrigins.includes("*") || config.allowedOrigins.includes(origin);
  if (!allowed) return;
  res.setHeader("access-control-allow-origin", config.allowedOrigins.includes("*") ? "*" : origin);
  res.setHeader("vary", "Origin");
  res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
  res.setHeader("access-control-allow-headers", "Content-Type");
  res.setHeader("access-control-max-age", "86400");
}
