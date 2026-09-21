import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { archiveRelativePath, archiveWorkKey, safeArchiveName, writeArchive } from "../archive.mjs";

const testBase = process.env.ARCHIVE_TEST_ROOT || os.tmpdir();
await mkdir(testBase, { recursive: true });
const root = await mkdtemp(path.join(testBase, ".shiguang-archive-test-"));
try {
  const taskDir = path.join(root, "task-cache");
  const archiveRoot = path.join(root, "archive");
  await mkdir(taskDir, { recursive: true });
  await writeFile(path.join(taskDir, "临时1.jpg"), "photo-one");
  await writeFile(path.join(taskDir, "临时2.jpg"), "photo-two");
  const task = {
    id: "task-1", directory: taskDir, sourceUrl: "https://v.douyin.com/test/",
    normalizedUrl: "https://www.douyin.com/note/123", result: { videoId: "123", author: "小明", title: "测试文案", type: "image" },
    files: [
      { role: "image", index: 0, filename: "临时1.jpg", contentType: "image/jpeg", size: 9 },
      { role: "image", index: 1, filename: "临时2.jpg", contentType: "image/jpeg", size: 9 },
    ],
  };
  assert.equal(archiveWorkKey(task), "douyin:123");
  assert.equal(safeArchiveName(' 小/明:* '), "小_明__");
  const relativePath = archiveRelativePath("小明", 1);
  const record = { workKey: "douyin:123", author: "小明", sequence: 1, folderName: "小明", relativePath };
  const result = await writeArchive({ root: archiveRoot, task, rawApi: { create_time: 1700000000, comment_count: 3 }, record });
  assert.equal(result.status, "completed");
  const files = await readdir(path.join(archiveRoot, relativePath));
  assert.deepEqual(files.sort(), ["作品信息.txt", "原始数据.json", "小明-照片2.jpg", "小明.jpg", "归档清单.json"].sort());
  assert.match(await readFile(path.join(archiveRoot, relativePath, "作品信息.txt"), "utf8"), /评论：3/);
  const manifest = JSON.parse(await readFile(path.join(archiveRoot, relativePath, "归档清单.json"), "utf8"));
  assert.equal(manifest.files.length, 2);
  assert.equal(manifest.files[0].sha256.length, 64);
  assert.equal((await writeArchive({ root: archiveRoot, task, rawApi: {}, record })).status, "existing");
  assert.equal((await readdir(path.join(archiveRoot, "小明"))).some((name) => name.endsWith(".part")), false);
  console.log("archive-test: ok");
} finally {
  await rm(root, { recursive: true, force: true });
}
