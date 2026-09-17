# 页面背景与图表标题 HTTP 离线交付验收

本片把页面背景图和已支持的图表标题一起走正式上传、发布、候选与离线打开链，使用隔离数据，不修改用户项目。

## 已验证

- 真实 HTTP multipart 调用 `/api/projects/:projectId/assets/images` 上传 32×16 半透明 PNG，再通过资源列表读取登记结果。使用正式媒体路由、JsonStore 与 LocalObjectStore，不直接伪造资源记录。图片临时目录与 LocalObjectStore 根一致，符合该适配器的原地存储合同。
- 应用经 HTTP 创建、编辑、发布及公共版本读取，重开磁盘 store 后从同一发布 revision 生成候选；图表数据仍是 A=37、B=91，标题和单位使用已有 OFL Source Sans 3 正常/粗体字节。
- `original/right/repeat` 背景冻结为 `pageIds: ["page-main"]`、`nodeIds: []`。编译器 `backgroundBindings` 独立绑定源 SHA、页面、atlas 与像素 SHA；作者能力和 `renderedNodeIds` 只有 `portable-author-bar`，背景不增加作者完成数。
- ZIP 解包后播放器、DMDA 导入播放器和无参数单 EXE 均实际呈现。三个产物携带的运行包字节相同；ZIP 校验 CRC 与逐文件 SHA，EXE 校验嵌包长度和 SHA。独立 EXE 无旁置文件，播放器 PATH 仅 Windows System32，无浏览器/Node 运行依赖。

正式候选不公开编译器内部 binding，因此验收按候选**原始冻结清单**的 `sourceRevision` 重读同批数据/资源，要求冻结清单及编译产物逐字节一致，再核验内部 binding。不能重新 derive 后比较，因为新捕获时间代表另一份合法数据快照。本轮 r1 的补验曾因此拒绝，r2 修正验收输入后全链通过，未修改生产快照语义。

## 证据

最终目录：`test-output/dashboard-http-background-20260917-r2/`，包含 `evidence.json`、`prepared-evidence.json`、发布记录、运行包、三种下载产物及打开日志。

| 项目 | 结果 |
|---|---|
| Native Release SHA-256 | `a729bdee2f8f9782af5302098a17301f691c72844b2284450eef5b0d13032e45` |
| 上传图片 SHA-256 | `a87eef138263fd2ee875f90321f93ae846a3fcfa907fc8e1bda4507782fc55a8` |
| 背景图集 | 960×540，2,073,600 bytes，全量 RGBA `[20,40,60,128]` |
| 背景像素 SHA-256 | `83a70105c61591cf809ab20b518de9638083c0d6264422c4b4a35184a0dede50` |
| 运行包 SHA-256 | `de8c399e40bad8e27178c70779ab1a5f83493db5ee4bee1352a2d572334198b5` |
| ZIP | 5,743,481 bytes；SHA `1afba65643ca41d3818f030e1a7c9fc296382eda20e838a614e045a0913fc7b0` |
| 单 EXE | 17,915,668 bytes；SHA `69296fcbcffdc9ac1f63a791f1b7a3c08d1712c74f3b46fcc13063ad19828c95` |
| Native | RTX 4060 Laptop / Vulkan；候选与 ZIP 各 3 帧 clean；3 atlases、2,089,056 bytes、3 image quads |

复现：先运行 `node scripts/build-dashboard-content-compiler.mjs`，配置已有 `DASHBOARD_HEADING_FONT_MANIFEST`，再运行 `verify-dashboard-published-portable.mts <release.exe> <device-sha256> <new-output> --background-heading`。设备 SHA 与字体配置用[标题 HTTP 验收](dashboard-http-heading-delivery-2026-09-17.md)的同机值。

聚焦上传/HTTP/字体测试 6/6，专属严格 TypeScript 与 repository gate 通过。缺项目 404、非法图片扩展名 415、JSON/multipart 混用拒绝均覆盖。候选删除后三种下载均 404，客户端改写播放器路径请求 400。旧 `--chart-heading` 双图集真实下载/打开回归见 `test-output/dashboard-http-heading-regression-20260917-r1/`。

主线独立复核：重新执行三份聚焦测试共6项及 `tsc -p scripts/tsconfig.dashboard-acceptance.json` 全部通过；直接读取磁盘 ZIP、独立 EXE、runtime-package.json 的 SHA-256，逐项匹配上表。复读 downloaded-open.json 确认 ZIP 的三帧 Vulkan 呈现及 DMDA 检查点证据；本次复核未重新启动整条 HTTP/播放器链。

## 范围

本片不改视觉实现；背景双主题、多轮 CSS 对照与定位/平铺回归见[生成器验收](dashboard-page-background-producer-2026-09-17.md)。像素 SHA 是实际包内图集校验，不是 GPU framebuffer readback。系统登录、生产 PostgreSQL/MinIO、任意客户图、中文标题字体、跨宿主逐像素一致不在本次固定夹具证据内；作者图表仍为 degraded，交互与 `appearance.crossHost` 等原缺口未提升。

工程技能十维自检均为 9：复用正式上传/编译/下载链、隔离存储、原快照绑定、失败路径、全链真机与旧分支回归构成本片证据。不新增依赖或视觉样式。
