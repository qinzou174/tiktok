# HTTP API

所有响应使用 JSON，媒体文件接口除外。默认基础地址为当前域名；前后端分离时由 `public/config.js` 配置。

## 健康检查

`GET /api/health`

```json
{
  "ok": true,
  "concurrency": 4,
  "activeWorkers": 1,
  "queued": 2
}
```

## 查询任务列表

`GET /api/tasks`

返回按创建时间倒序排列的任务，以及当前运行数和排队数。

## 创建任务

`POST /api/tasks`

```json
{
  "text": "一段包含一个或多个抖音链接的分享文案"
}
```

- 后端会抽取并去重所有 HTTP/HTTPS 链接。
- 每个链接创建一个独立任务。
- 成功返回 HTTP `202`。

## 查询单个任务

`GET /api/tasks/:taskId`

主要状态：

- `queued`：等待工作槽位
- `resolving`：识别并规范化分享链接
- `parsing`：调用远梦 API
- `downloading`：媒体保存到本地
- `retrying`：等待自动重试
- `completed`：完成
- `failed`：最终失败或永久错误

任务中包含：来源地址、标准地址、尝试次数、进度、错误、解析类型、作者、文案、媒体文件、作者序号、创建/到期时间。

## 手动重试

`POST /api/tasks/:taskId/retry`

仅失败或已结束的任务可重新入队。正在执行的任务返回 HTTP `409`。

## 查看或下载文件

`GET /api/tasks/:taskId/files/:filename`

- 默认以内联方式返回，可直接供 `<video>`、`<audio>` 和 `<img>` 使用。
- 增加 `?download=1` 时返回附件下载。
- 支持 `Range`，视频和音频可以拖动播放进度。
- `Content-Disposition` 使用 SQLite 分配后的作者文件名。

## 错误格式

```json
{
  "error": "任务不存在或已过期"
}
```

常见状态码：`400` 输入无效、`404` 不存在或过期、`409` 状态冲突、`500` 后端异常。
