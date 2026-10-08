# 完整编辑器托管

Pages 默认提供 [浏览器本地体验](online-browser.md)：完整编辑器、SMT、素材和示例数据，编辑保存在 IndexedDB。需要多人共享工程、工业转换、外部数据与 Agent 时，使用下述独立 API 配置。[GitHub Pages 托管静态文件](https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages)。

## 前端

在仓库根执行，输出必须是新的独立目录：

```sh
node scripts/prepare-full-editor-pages.mjs test-output/editor-pages https://api.studio.example.org /DeepMonkey-Studio/
```

构建复用普通编辑器入口、现有Vite和生产开发页裁剪；不覆盖 `apps/web/dist` 或Core产物。输出包含 `index.html`、`404.html`、`.nojekyll` 和 `editor-hosting.json`。放在Pages项目根后，工作台URL为 `/DeepMonkey-Studio/`，视频仍可放在 `video.html`，只读样例仍可放在 `browse/`。API域名示例需替换为真正的独立演示服务。

API origin可在构建时通过 `VITE_STUDIO_API_ORIGIN` 设置，或修改入口HTML中的 `studio-api-origin` meta。只接受不含凭据、路径、查询与片段的HTTP(S) origin；HTTPS页面使用HTTPS API。缺省同源，原本机、Docker和客户端入口保持原合同。

根路由由 `routePath` 加Web base，读路由时去base。模型、纹理和媒体的管理URL解析到API；保存时还原为管理路径。冻结资源依赖中的严格 `/api/...` 路径保留原形，由ServerClient请求，避免破坏资源校验。WebSocket沿用服务profile和现有鉴权子协议；令牌不会从另一个API的旧会话中借用。

## 独立API

配置为 `deploy/online-editor/compose.yml`，使用现有0.2.0镜像。将该目录的 `.env.example` 复制为独立私有环境文件，设置随机数据库、MinIO、管理员和会话凭据。公开Pages对应 `STUDIO_ONLINE_WEB_ORIGIN=https://fatasia.github.io`；本地静态QA对应 `http://localhost:44101`。

```sh
docker compose -p studio-online-editor --env-file /private/online-editor.env -f deploy/online-editor/compose.yml config --quiet
docker compose -p studio-online-editor --env-file /private/online-editor.env -f deploy/online-editor/compose.yml up -d --no-build --pull never --wait
```

初期API仅监听 `127.0.0.1:44100`，PostgreSQL/MinIO不暴露宿主端口。三个卷按Compose项目作用域隔离，使用不同项目名即得到独立存储；不叠加原工作区Compose或复用本机私有服务。卷的默认作用域行为见[Docker官方说明](https://docs.docker.com/reference/compose-file/volumes/)。

公开HTTPS服务由 `Caddyfile.example` 反代独立44100；路径、流式请求和WebSocket由既有API消费。Caddy的反代支持WebSocket升级，[官方配置说明](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy)。本轮没有启用公网反代。

模型服务密钥在服务端设置；Native窗口和Windows离线运行使用对应客户端。浏览器中的编辑能力与服务端能力状态按实际可用性显示。

## 验证状态

`node scripts/verify-online-editor-hosting.mjs` 实际解析Compose配置，检查loopback绑定、存储端口和隔离卷，不启动容器。94项Web合同/消费者回归测试（13文件）覆盖API地址、真实ServerClient请求/鉴权、管理资产读写、Pages路由、WS地址和冻结依赖。最终Web类型检查通过，文档跳转、默认入口和发布复制地址均保留Web base。

独立前端三次实际构建成功，最新为 `test-output/studio-full-editor-hosting/frontend-20261007-r3`。2026-10-07 21:32 本地分源实测全部通过：子路径/刷新/静态入口、CORS预检、登录、GLB上传转换及MinIO原字节读回、场景保存重读和发布、12行实际处理、本体持久化/图查询、鉴权跨源WebSocket事件。发布请求使用既有 `expectedSnapshot` 合同。测试报告为 `test-output/studio-full-editor-hosting/live-qa-20261007/report.json`，前端文件哈希与构建身份在同目录 `source-identity.json`。

完整实测命令：

```sh
node scripts/verify-full-editor-online.mjs test-output/studio-full-editor-hosting/frontend-20261007-r3 --keep
```

这条命令会启动独立三服务，使用新随机凭据和独立Compose项目，`pull never`，执行真实静态/CORS/登录/上传/保存/发布/流程/本体/WS检查。无 `--keep` 时检查后清理本次测试容器、网络与卷；本轮已清理。完整UI验收仍须浏览器完成登录、2D/3D/脚本编辑、重载、关系编辑、Agent和交付操作，以及桌面/移动两轮截图；公开部署安排在Deep验收后。
