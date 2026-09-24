# 服务器部署

## 推荐：Docker Compose

服务器需要 Docker Engine 和 Compose 插件。

需要生成不含密钥和本地媒体的部署压缩包时，在 Windows 项目目录运行：

```powershell
.\scripts\package.ps1
```

1. 将整个项目复制到服务器，例如 `/opt/douyin-parser-web`。
2. 复制 `.env.example` 为 `.env`，填写 `QZQI_API_KEY` 和宿主机的 `NAS_ARCHIVE_PATH`；生产环境保留 `ARCHIVE_ROOT=/app/archive`。
3. 保持 `compose.yaml` 默认只监听 `127.0.0.1:4173`。
4. 在项目目录运行 `docker compose up -d --build`。
5. 用 `docker compose ps` 和 `curl http://127.0.0.1:4173/api/health` 检查健康状态。
6. 按 `deploy/nginx.conf.example` 配置 HTTPS 反向代理。

升级时替换源文件后执行 `docker compose up -d --build`。`data/` 是宿主机挂载目录，不会随容器重建丢失。

Compose 只会把 `NAS_ARCHIVE_PATH` 指定的宿主机目录挂载到 `/app/archive`。该目录需要对容器内 UID 1000 可写；不要为了部署而递归修改已有媒体的所有者或权限。

## 原生 Node.js + systemd

服务器需要 Node.js 24 或更新版本，因为项目使用内置 `node:sqlite`。

1. 把项目放到 `/opt/douyin-parser-web`。
2. 创建 `.env`，并确保运行用户可写 `data/`。
3. 修改 `deploy/shiguang.service.example` 的用户和路径。
4. 将其复制到 `/etc/systemd/system/shiguang.service`。
5. 执行 `systemctl daemon-reload && systemctl enable --now shiguang`。
6. 使用 Nginx 反向代理到 `127.0.0.1:4173`。

## 前后端物理分离

1. 将 `public/` 发布到静态站点。
2. 修改静态站点中的 `config.js`：

```js
window.APP_CONFIG = { apiBaseUrl: "https://api.example.com" };
```

3. 后端 `.env` 加入：

```dotenv
ALLOWED_ORIGINS=https://www.example.com
```

多个前端域名用英文逗号分隔。不要在生产环境随意使用 `*`。

## 上线前检查

- `.env` 未进入压缩包、镜像层或公开目录。
- 公网入口启用了 HTTPS 和身份验证/访问控制。
- `data/` 有足够空间，并纳入服务器备份策略；如不需要保留作者序号，可不备份任务媒体，但应备份 `naming.sqlite`。
- 任务为串行调度（一次一个、间隔 3 秒），无需并发参数；如需缩短或拉长节奏，调整 `server.mjs` 中的 `TASK_GAP_MS`。
- 验证视频 Range 请求、24 小时清理、容器重启后的任务恢复，以及同作者序号连续性。
- 验证同一作品重复提交不增加归档序号，新作品生成下一个 `UP主（N）`，并检查归档目录内不存在遗留 `.part` 目录。
