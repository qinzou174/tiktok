import assert from "node:assert/strict";
import { access, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const base = process.env.TEST_BASE_URL || "http://127.0.0.1:4173";
const checks = [];

async function check(name, fn) {
  try {
    await fn();
    checks.push({ name, ok: true });
  } catch (error) {
    checks.push({ name, ok: false, error: error.message });
  }
}

await check("health endpoint", async () => {
  const response = await fetch(`${base}/api/health`);
  const data = await response.json();
  assert.equal(response.status, 200);
  assert.equal(data.ok, true);
  assert.ok(data.concurrency >= 1 && data.concurrency <= 20);
  assert.ok(Number.isInteger(data.delayedRetries));
});

await check("frontend entrypoints and generated asset", async () => {
  for (const target of ["/", "/task", "/styles.css", "/app.js", "/detail.js", "/config.js", "/assets/dream-amber-v1.png"]) {
    const response = await fetch(`${base}${target}`);
    assert.equal(response.status, 200, target);
  }
  const image = await fetch(`${base}/assets/dream-amber-v1.png`);
  assert.match(image.headers.get("content-type") || "", /^image\/png/);
  const appScript = await (await fetch(`${base}/app.js`)).text();
  assert.match(appScript, /addEventListener\("input"/);
  assert.match(appScript, /\/shiguang-api/);
  assert.doesNotMatch(appScript, /setInterval\(render/);
  const detailScript = await (await fetch(`${base}/detail.js`)).text();
  assert.match(detailScript, /const BASE_PATH/);
  assert.match(detailScript, /\/shiguang-api/);
});

await check("invalid JSON returns 400", async () => {
  const response = await fetch(`${base}/api/tasks`, { method: "POST", headers: { "content-type": "application/json" }, body: "{" });
  assert.equal(response.status, 400);
  const data = await response.json();
  assert.match(data.error, /请求格式无效/);
});

await check("unsupported URLs are rejected before task creation", async () => {
  const before = await (await fetch(`${base}/api/tasks`)).json();
  const response = await fetch(`${base}/api/tasks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "https://example.com/not-douyin" }),
  });
  assert.equal(response.status, 400);
  const after = await (await fetch(`${base}/api/tasks`)).json();
  assert.equal(after.tasks.length, before.tasks.length);
});

await check("CORS preflight is bounded", async () => {
  const response = await fetch(`${base}/api/tasks`, { method: "OPTIONS", headers: { origin: "https://untrusted.example", "access-control-request-method": "GET" } });
  assert.equal(response.status, 204);
  assert.equal(response.headers.get("access-control-allow-origin"), null);
});

await check("SSE sends an initial snapshot", async () => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3_000);
  try {
    const response = await fetch(`${base}/api/events`, { signal: controller.signal });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") || "", /^text\/event-stream/);
    const reader = response.body.getReader();
    const first = await reader.read();
    const text = new TextDecoder().decode(first.value);
    assert.match(text, /event: snapshot/);
    assert.match(text, /"tasks"/);
    await reader.cancel();
  } finally {
    clearTimeout(timeout);
    controller.abort();
  }
});

let tasks = [];
await check("task list shape", async () => {
  const response = await fetch(`${base}/api/tasks`);
  const data = await response.json();
  assert.equal(response.status, 200);
  assert.ok(Array.isArray(data.tasks));
  assert.ok(Number.isInteger(data.activeWorkers));
  assert.ok(Number.isInteger(data.queued));
  tasks = data.tasks;
});

await check("SQLite integrity and naming uniqueness", async () => {
  const db = new DatabaseSync(path.join(root, "data", "naming.sqlite"), { readOnly: true });
  const result = db.prepare("PRAGMA integrity_check").get();
  assert.equal(result.integrity_check, "ok");
  const duplicate = db.prepare("SELECT author, sequence, COUNT(*) AS count FROM task_names GROUP BY author, sequence HAVING count > 1").get();
  assert.equal(duplicate, undefined);
  db.close();
});

await check("completed task files match disk metadata", async () => {
  for (const task of tasks.filter((item) => item.status === "completed")) {
    assert.ok(task.result?.author);
    assert.ok(task.naming?.sequence >= 1);
    for (const file of task.files) {
      const filePath = path.join(root, "data", "tasks", task.id, file.filename);
      await access(filePath);
      const info = await stat(filePath);
      assert.equal(info.size, file.size, `${task.id}/${file.filename}`);
    }
    const diskTask = JSON.parse(await readFile(path.join(root, "data", "tasks", task.id, "task.json"), "utf8"));
    assert.equal(diskTask.status, task.status);
  }
});

await check("media range and download filename", async () => {
  const task = tasks.find((item) => item.status === "completed" && item.files?.length);
  if (!task) return;
  const file = task.files[0];
  const url = `${base}/api/tasks/${task.id}/files/${encodeURIComponent(file.filename)}`;
  const prefix = await fetch(url, { headers: { range: "bytes=0-9" } });
  assert.equal(prefix.status, 206);
  assert.equal((await prefix.arrayBuffer()).byteLength, 10);
  assert.match(prefix.headers.get("content-range") || "", /^bytes 0-9\//);

  const suffix = await fetch(url, { headers: { range: "bytes=-10" } });
  assert.equal(suffix.status, 206);
  assert.equal((await suffix.arrayBuffer()).byteLength, Math.min(10, file.size));

  const invalid = await fetch(url, { headers: { range: `bytes=${file.size + 10}-` } });
  assert.equal(invalid.status, 416);
  assert.equal(invalid.headers.get("content-range"), `bytes */${file.size}`);

  const download = await fetch(`${url}?download=1`, { headers: { range: "bytes=0-0" } });
  assert.match(download.headers.get("content-disposition") || "", /^attachment;/);
  assert.ok((download.headers.get("content-disposition") || "").includes(encodeURIComponent(file.filename)));
});

await check("photo collection downloads as a ZIP", async () => {
  const task = tasks.find((item) => item.status === "completed" && item.files?.some((file) => ["image", "cover"].includes(file.role)));
  if (!task) return;
  const response = await fetch(`${base}/api/tasks/${task.id}/photos.zip`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") || "", /^application\/zip/);
  assert.match(response.headers.get("content-disposition") || "", /%E5%85%A8%E9%83%A8%E7%85%A7%E7%89%87\.zip/);
  const bytes = new Uint8Array(await response.arrayBuffer());
  assert.equal(Buffer.from(bytes.subarray(0, 4)).readUInt32LE(), 0x04034b50);
  assert.equal(Buffer.from(bytes.subarray(-22, -18)).readUInt32LE(), 0x06054b50);
});

for (const item of checks) console.log(`${item.ok ? "PASS" : "FAIL"}  ${item.name}${item.error ? ` — ${item.error}` : ""}`);
const failed = checks.filter((item) => !item.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
if (failed.length) process.exit(1);
