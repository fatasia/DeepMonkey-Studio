# 在线工作台与场景浏览

在线目标是在Pages页面内体验完整编辑器：创作场景、保存工程、编辑数据流程和本体关系、运行应用，再发布交付。正式发布安排在Deep引擎验收之后；子路径/独立API配置已实现并通过合同测试，完整在线工作台尚未公开部署。新三分钟介绍片沿SMT主线重新制作。

入口为 [Deep Monkey Studio](https://fatasia.github.io/DeepMonkey-Studio/)。当前线上仍是旧版视频页。已准备的「打开在线样例」提供以下查看工具：

1. 拖动场景旋转视角，滚轮缩放；点击对象查看属性。
2. 用工具坞切换标准视角、测量和剖切；「全部适配」恢复总览。
3. 打开对象面板查找和显隐对象，或进入全屏查看。

这个样例是冻结的只读发布版本，资源在浏览器本地渲染；它是完整在线工作台的中间基础。完整工作台通过Windows或Docker运行，0.2.0下载将在[Release页面](https://github.com/fatasia/DeepMonkey-Studio/releases)提供。

0.2.0 页面将提供三分钟系统介绍和功能实录两部视频，支持中文字幕和下载。

## 完整编辑器的在线部署

GitHub Pages 可以托管完整 Web 前端；工程保存、模型转换、数据处理、本体持久化、Agent 和发布仍需真实 API 服务。仓库已有 Fastify API、PostgreSQL、MinIO 和工业转换 worker 的 Docker 部署链，下一步复用这条链配置独立演示服务。

| 能力 | 运行位置与依赖 |
| --- | --- |
| 2D / 3D / 脚本编辑、时间线、材质、浏览器渲染 | Web 前端；工程及资源由 API 提供 |
| 登录、项目保存、上传、转换、流程、本体、发布 | API、持久化存储和现有 worker |
| Agent 与 LLM | API 中配置模型服务；密钥保留在服务端 |
| Deep WebGPU / Deep WASM | 浏览器能力与随包引擎资源 |
| Native 客户端、本地离线交付 | Windows 客户端和下载包 |

浏览器支持构建变量 `VITE_STUDIO_API_ORIGIN`，也可用HTML中的 `meta[name="studio-api-origin"]` 在运行时指定API origin；缺省仍为网页自身origin。Web路由和静态资源使用Vite base；HTTP/WS和API管理的模型资源使用API origin，令牌按服务隔离。工程保存将当前API资产地址还原成可迁移的管理路径。Vite开发代理继续按原方式工作。

隔离配置、最短构建命令和验证状态见[完整编辑器托管](full-editor-hosting.md)。GitHub Pages部署根使用 `/DeepMonkey-Studio/`；生成的 `404.html` 复用同一个编辑器入口，使深链接与刷新能加载工作台。配套API服务独立部署，CORS的 `WEB_ORIGIN` 配置为 `https://fatasia.github.io`。

验收需要走真实功能路径：登录、创建项目、导入和编辑 3D、编辑 2D 与脚本、保存后重载、连接数据、运行流程、编辑本体、执行 Agent 任务、发布应用和导出交付包。公开演示服务使用独立工程、样本与凭据；不连接本机私有 API。仅有静态站点和只读浏览 ZIP 时，不记为完整在线编辑器完成。

## 自己发布静态样例

复用只读场景交付链，不需要另写三维播放器：

1. 发布基础几何样例并导出冻结的 Three Webview ZIP。
2. 用专用 SceneViewer 构建，Vite base 与目标网站子路径保持一致；通过 `build-scene-viewer.mjs --stage-only` 验证资源闭包。
3. 执行 `node scripts/prepare-pages-scene-viewer.mjs <stage frontend> <new output> /DeepMonkey-Studio/browse/`，生成浏览 ZIP 和文件哈希清单。

仓库 Pages workflow 从 Release 下载浏览 ZIP、两部成片及字幕，核对 `SHA256SUMS.txt` 后部署。公开示例封包入口仅接受自产基础几何；一般项目场景使用现有客户端/Docker 发布链。

GitHub Pages 托管 HTML、CSS 和 JavaScript 静态文件；服务端数据处理和工程分析放在客户端或 Docker 中运行。[GitHub 官方说明](https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages)。

部署时计算展开后的站点总大小，包括视频和浏览资源；Pages 站点上限为 1 GB。[Pages 限制](https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits)。较大的客户端和容器归档放在 Release，每个附件须小于 2 GiB。[Release 附件限制](https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases)。
