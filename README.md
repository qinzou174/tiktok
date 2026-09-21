# 拾光 · 抖音媒体解析台

一个可本地运行、也可直接迁移到 Linux 服务器的抖音视频、照片/图集和实况解析工具。前端是独立静态页面，后端负责限流队列、分级重试、远梦 API、本地媒体、NAS 归档、SQLite 作者序号和 24 小时生命周期。

## 本地启动

Windows 双击 `启动解析台.cmd`，或运行：

```powershell
npm start
```

打开 `http://localhost:4173`。

## 核心能力

- 粘贴分享文案或多条链接后立即建任务并清空输入框。
- 远梦 API 使用全局单通道：同时最多一个请求，相邻请求启动间隔至少 1 秒。
- 首次任务优先；失败任务暂停到首次任务全部结束后再逐个重试。
- 媒体下载和归档保持有界并发，每任务最多同时下载 3 个媒体文件。
- 短链接和 `iesdouyin.com/share/note` 自动转换为标准作品地址。
- 网络超时与远梦上游故障采用指数退避自动重试，默认最多 8 次。
- 图片、视频、实况片段与音乐真实保存到 `data/tasks/`，支持播放进度 Range 请求。
- 每个任务从创建时起独立保留 24 小时，服务重启后仍能恢复任务。
- SQLite 持久记录作者作品序号：`作者.jpg`、`作者.2.jpg`、`作者.3.jpg`。
- API Key 只保存在后端 `.env`，不会进入浏览器、镜像或版本库。
- 可选永久归档按 `UP主/UP主（N）` 分类，并保存作品信息、完整 API JSON 和 SHA-256 清单。

## 配置

| 变量 | 默认值 | 说明 |
|---|---:|---|
| `QZQI_API_KEY` | 必填 | 远梦 API Key |
| `PORT` | `4173` | 后端监听端口 |
| `MAX_CONCURRENCY` | `4` | 媒体下载与归档任务并发，范围 1–20 |
| `TASK_TTL_HOURS` | `24` | 每个任务的独立保留时间 |
| `MAX_RETRIES` | `8` | 可重试故障的最大尝试次数 |
| `ALLOWED_ORIGINS` | 空 | 前后端分离时允许的前端域名，逗号分隔 |
| `ARCHIVE_ROOT` | `/app/archive` | 容器内永久归档目录 |
| `NAS_ARCHIVE_PATH` | `./archive` | Compose 挂载的宿主机归档目录 |

## 文档

- [项目架构](docs/ARCHITECTURE.md)
- [HTTP API](docs/API.md)
- [服务器部署](docs/DEPLOYMENT.md)

服务器推荐使用 `Dockerfile` 与 `compose.yaml`；Nginx 和 systemd 示例位于 `deploy/`。

服务运行时可执行 `npm test`，检查健康接口、静态资源、SQLite 完整性、任务文件、媒体 Range、归档原子性以及 API 单通道调度。
