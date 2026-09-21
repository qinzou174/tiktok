import { createHash } from "node:crypto";
import { access, copyFile, link, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

export function archiveWorkKey(task) {
  const id = String(task?.result?.videoId || "").trim();
  if (id) return `douyin:${id}`;
  const url = String(task?.normalizedUrl || task?.sourceUrl || "").trim();
  return `url:${createHash("sha256").update(url).digest("hex")}`;
}

export function safeArchiveName(value) {
  let safe = String(value || "未知作者").trim().replace(/\s+/g, " ")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").replace(/[.。．·・… ]+$/g, "").slice(0, 80);
  if (!safe) safe = "未知作者";
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(safe)) safe = `_${safe}`;
  return safe;
}

export function archiveRelativePath(author, sequence, folderName = safeArchiveName(author)) {
  return path.join(folderName, `${folderName}（${sequence}）`);
}

export async function archivePathExists(root, relativePath) {
  try { await access(resolveInside(root, relativePath)); return true; } catch { return false; }
}

export async function writeArchive({ root, task, rawApi, record }) {
  if (!root) return { status: "disabled" };
  const finalDir = resolveInside(root, record.relativePath);
  const parentDir = path.dirname(finalDir);
  const stageDir = path.join(parentDir, `.${task.id}.part`);
  await mkdir(parentDir, { recursive: true });
  if (await archivePathExists(root, record.relativePath)) return manifestResult(record, finalDir, "existing");

  await rm(stageDir, { recursive: true, force: true });
  await mkdir(stageDir, { recursive: true });
  try {
    const archivedFiles = [];
    for (const file of task.files || []) {
      const source = path.join(task.directory, file.filename);
      const extension = path.extname(file.filename).replace(/^\./, "") || "bin";
      const filename = archiveMediaFilename(record.folderName, record.sequence, file, extension);
      const destination = path.join(stageDir, filename);
      await linkOrCopy(source, destination);
      const info = await stat(destination);
      archivedFiles.push({ ...file, filename, size: info.size, sha256: await sha256File(destination) });
    }
    if (!archivedFiles.length) throw new Error("作品没有可归档的媒体文件");

    const manifest = {
      schemaVersion: 1, workKey: record.workKey, taskId: task.id, author: record.author,
      sequence: record.sequence, archivedAt: new Date().toISOString(), sourceUrl: task.sourceUrl,
      normalizedUrl: task.normalizedUrl, result: task.result, files: archivedFiles,
    };
    await atomicWrite(path.join(stageDir, "作品信息.txt"), buildInfoText(task, rawApi, record, archivedFiles));
    await atomicWrite(path.join(stageDir, "原始数据.json"), `${JSON.stringify(rawApi ?? null, null, 2)}\n`);
    await atomicWrite(path.join(stageDir, "归档清单.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    await rename(stageDir, finalDir);
    return { ...manifestResult(record, finalDir, "completed"), files: archivedFiles };
  } catch (error) {
    await rm(stageDir, { recursive: true, force: true });
    throw error;
  }
}

function archiveMediaFilename(author, sequence, file, extension) {
  const base = sequence > 1 ? `${author}.${sequence}` : author;
  const suffix = file.role === "image" && file.index > 0 ? `-照片${file.index + 1}` : "";
  return `${base}${suffix}.${extension}`;
}

async function linkOrCopy(source, destination) {
  try { await link(source, destination); }
  catch (error) {
    if (!["EXDEV", "EPERM", "EACCES", "ENOTSUP"].includes(error.code)) throw error;
    await copyFile(source, destination);
  }
}

async function atomicWrite(target, content) {
  const temporary = `${target}.tmp`;
  await writeFile(temporary, content, "utf8");
  await rename(temporary, target);
}

async function sha256File(file) {
  const hash = createHash("sha256");
  hash.update(await readFile(file));
  return hash.digest("hex");
}

function resolveInside(root, relativePath) {
  const absoluteRoot = path.resolve(root);
  const target = path.resolve(absoluteRoot, relativePath);
  if (target !== absoluteRoot && !target.startsWith(`${absoluteRoot}${path.sep}`)) throw new Error("归档路径越界");
  return target;
}

function manifestResult(record, _finalDir, status) {
  return { status, workKey: record.workKey, author: record.author, sequence: record.sequence, relativePath: record.relativePath };
}

function buildInfoText(task, rawApi, record, files) {
  const published = findFirst(rawApi, ["create_time", "createTime", "publish_time", "publishTime"]);
  const stats = [
    ["点赞", findFirst(rawApi, ["digg_count", "like_count", "diggCount"])],
    ["评论", findFirst(rawApi, ["comment_count", "commentCount"])],
    ["收藏", findFirst(rawApi, ["collect_count", "favorite_count", "collectCount"])],
    ["分享", findFirst(rawApi, ["share_count", "shareCount"])],
  ].filter(([, value]) => value !== undefined);
  const lines = [
    "抖音作品归档", "=".repeat(48),
    `归档时间：${new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}`,
    `UP 主：${record.author}`, `作者内作品序号：${record.sequence}`,
    `作品类型：${task.result?.type || "未知"}`, `作品 ID：${task.result?.videoId || "未提供"}`,
    `发布时间：${formatTime(published)}`, `标题／文案：${task.result?.title || "未提供"}`,
    `原始链接：${task.sourceUrl || "未提供"}`, `规范链接：${task.normalizedUrl || "未提供"}`,
    "", "互动数据", "-".repeat(48), ...(stats.length ? stats.map(([label, value]) => `${label}：${value}`) : ["API 未提供"]),
    "", "媒体文件", "-".repeat(48), ...files.map((file) => `${file.filename}｜${file.role}｜${file.size} 字节｜SHA-256 ${file.sha256}`),
    "", "作者信息", "-".repeat(48), JSON.stringify(task.result?.authorInfo ?? {}, null, 2),
    "", "说明", "-".repeat(48), "完整 API 响应见“原始数据.json”，结构化文件校验信息见“归档清单.json”。", "",
  ];
  return lines.join("\n");
}

function findFirst(value, keys) {
  if (!value || typeof value !== "object") return undefined;
  for (const key of keys) if (value[key] !== undefined && value[key] !== null) return value[key];
  for (const child of Object.values(value)) {
    if (child && typeof child === "object") { const result = findFirst(child, keys); if (result !== undefined) return result; }
  }
  return undefined;
}

function formatTime(value) {
  if (value === undefined) return "API 未提供";
  const number = Number(value);
  const date = Number.isFinite(number) ? new Date(number < 10_000_000_000 ? number * 1000 : number) : new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" });
}
