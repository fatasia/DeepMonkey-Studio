# 0.2.0 在线浏览与两部介绍片

## 本轮续作核查

已有两片、字幕、章节、内容库存、冻结三基本几何样例和专用静态查看器。本轮复查脚本、合同、依赖、消费入口、四项 Pages 封包测试与旧录像来源；不重建播放器或发布清单。真实缺口是系统片缺少产品理念和技术表达，工业场景没有贯穿叙事；介绍页尚未播放当前两片，媒体错误没有文字反馈；Pages 仍待最终独立构建。按用户最新指令重构 180 秒系统片，旧可靠工业原生镜头与当前新增功能实录共同使用。

旁白全文为 `docs/assets/studio-020/intro-narration-180s.md`。七章分别为理念 18 秒、创作 26 秒、数据 24 秒、本体 28 秒、Agent 与行为 24 秒、三条引擎路径 32 秒、发布交付 28 秒。真实 SMT 产线在开场、创作、行为、技术和结尾出现；不把旧录屏当成本轮性能结果。首次 180 秒版本已保存在产物目录 `backup-intro-180s-initial/`。

当前发布范围以用户最新指令为准：不交付 Android 客户端。两部视频和 Pages 介绍只包含本次 Windows、离线包、SDK、Docker 与在线浏览产物。

## 现状核查

1. 已检索 web/contracts 源码、未跟踪文件、Pages workflow、docs、仓外 deliverables 与视频脚本。Pages 只复制 video.html/poster 并下载 v0.1.0 单片。
2. 已读 SceneViewerDeliveryManifest、SceneSnapshot、发布资源合同；复用现有冻结清单，不新增另一套查看器。
3. 现有 Vite、esbuild、JSZip、FFmpeg 8、Pillow 和 edge_tts 均有消费链。视频遵循 FFmpeg Video Editor skill；UI 只用 CUA。
4. 只读 SceneViewerRoot 已提供对象选择/属性、测量、剖切、爆炸和标准视图；现有 main scene-viewer 构建入口消费冻结 manifest。浏览器路径仍强制 /published，资源仍为根路径。
5. sceneViewerDelivery.test、scene-viewer-package-core.test、真实冻结 ZIP/SHA 证据已有。两部旧终稿、字幕、章节、旁白与剪辑脚本均齐备。
6. 已核对 continuation、release-offline、react-rt 续作及 9/26 视频发布报告；本轮用户要求两片体现新增功能，README 不改。

**已有（不重建）**：只读查看器、工具坞、冻结资源/ZIP 校验、Pages 发布 workflow，以及两部介绍片的成熟素材链。

**真实缺口**：GitHub 项目子路径的静态浏览入口；两部成片仍为 9 月内容，需要当前数据流程、本体图谱、渲染与离线交付片段；v0.2.0 两片资产、字幕、来源、校验与 Pages 入口尚未同步。

## 内容来源

- 系统介绍：`D:/Documents/bim/deliverables/system-intro-20260925/v3/DeepMonkey-Studio-系统介绍-V3.mp4`，202.47 秒；timeline.json/storyboard.json/旁白稿.md/render.py 保留。
- 功能录屏：`D:/Documents/bim/deliverables/system-feature-screencast-20260926/DeepMonkeyStudio-全功能系统介绍-1920x1080.mp4`，405.10 秒、34,044,375 bytes；v3-storyboard.json/v3-recording-manifest.json/全功能录屏旁白稿-v3.md/assemble_fullscreen_v3.py 保留。
- 旧片仅复用仍适用的章节；新增功能使用本轮 CUA 实录。Deep/Three 切换来自 user78e，WASM 来自新 worker 三体 QA；两者是不同场景。RT/LOD 的验收依据在工程报告中，影片不把编辑器镜头当性能探针。
- 新输出存放 `deliverables/studio-020-20261007/`，不覆盖历史片。Release 固定资产名为 `deepmonkey-studio-intro.mp4` 与 `deepmonkey-studio-features.mp4`，附同名 VTT/SRT 和 SHA-256。

## 在线能力与最新范围

用户最新要求是在Pages网页内体验编辑器全部功能，并明确安排在Deep引擎修复之后发布。原来的冻结只读查看器、三个自产基础几何样例和浏览ZIP保留为中间基础，不再代表Pages目标完成。已实现Web base、独立API origin和服务令牌隔离；两次隔离完整构建成功，94项合同/回归测试通过，公网部署和完整浏览器验收待完成。详见 `studio-online-editor-hosting-20261007.md` 与 `../guides/full-editor-hosting.md`。

GitHub Pages 提供静态 HTML/CSS/JavaScript，项目网站有仓库子路径（[官方说明](https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages)）。完整方案复用 Web 编辑器和既有 API/Docker 链；Pages 托管前端，独立演示服务承接真实工程、数据、转换、Agent 与发布操作。

### 完整在线工作台现状核查

1. 已检索 Web、API、server-sdk 和未跟踪文件中的入口、API origin、Pages、生产 Web、流程与本体关键词；现有 UI 与服务端能力不重建。
2. 已读 `ServerProfile`、`ServerClient`、`ServerMetaResponse`及流程/本体契约。API客户端已有profile注入；浏览器Host缺省返回location.origin，本轮增加可配置origin。
3. 已查 Vite 配置、API package、Docker compose。`/api`、`/assets`、`/health` 代理属于开发服务器；生产链已有 Fastify、PostgreSQL、MinIO 与工业 worker。
4. 消费链为 `api.ts` → `runtimeHost` → `BrowserHostAdapter` → `ServerClient`；普通 Web 由 `main.tsx` 加载编辑器，SceneViewer 构建只加载冻结查看器。API 的 `productionWeb.ts` 已提供同源 Web 和 SPA 回退。
5. 已查 BrowserHostAdapter / ServerClient / serverProfile / productionWeb 测试及当前 Docker 验证入口。BrowserHostAdapter 的同源行为有明确测试；只读 Pages 封包四项测试和本地查看证据已有。
6. 已核对本规格、在线指南、0.2.0 Docker/离线发布规格与最新用户顺序。完整 Pages 工作必须在 Deep 收尾之后执行，本轮不启动另一套静态模拟工作台。

**已有（不重建）**：完整 Web 编辑器、项目与发布 API、数据流程/本体服务、生产 Web 托管、Docker 持久化部署和可注入服务器 profile。

**真实缺口**：独立公开demo域名/服务配置、完整浏览器功能验收、三引擎与桌面/移动UI验收。API地址、子路径与登录隔离已实现；本地分源静态/CORS/登录、GLB转换及MinIO字节读回、保存重读与发布、流程、本体持久化/图查询、鉴权WS已在2026-10-07 21:32全部通过。当前Pages workflow仍只部署媒体和冻结样例。

### Deep 收尾后的实施顺序

1. 复用现有 Docker 服务准备独立 demo 工程和公开样本；API、数据库、对象存储、worker 与 LLM 配置在服务端运行。
2. 接入完整 Web 构建与可配置 API origin；统一路由基路径，验证深链接、刷新、上传下载、资产和实时通信。
3. 验证登录 → 创建/保存/重载工程 → 2D/3D/脚本编辑 → 流程运行 → 本体关系编辑 → Agent 执行 → 应用发布/导出。每项检查真实服务返回和持久化结果。

Pages本身不能运行数据库、LLM服务或Native进程；浏览器内Deep WebGPU/WASM沿用现有路径。公开演示使用独立数据与凭据，部署地址与容量尚待配置，当前状态为“基础改造/隔离构建通过，完整验收与公开部署待Deep后完成”。

## 当前验证

- 新建专用公开 QA Pages 场景 `d650e5ba-23ae-457e-8ea3-d778b1d55f00`，仅三个自产几何体，未修改用户当前场景。正式冻结 v2 导出 27,898-byte ZIP，无模型或外部资源。
- 静态 index 路径合同 3 tests 通过；CPU 公开样例封包 4 tests 通过，包括拒绝非子路径构建、原字节哈希不匹配和非示例模型。普通 Windows 路由仍按原合同工作。
- Pages workflow 下载六项 v0.2.0 资产（两部 MP4、两份 VTT、浏览 ZIP 与校验清单），逐项 SHA-256 校验后才解压/发布。静态浏览 ZIP 尚待最终构建与部署。
- 介绍页 CUA 桌面/390px 两轮截图：`test-output/studio-pages-020/round1-page-desktop.png`、`round2-page-mobile.png`。第二轮实际 scrollWidth=innerWidth=390，视频切换/键盘选择保持单个活动面板；两轮播放器兼容样本采用历史片，正式媒体稍后替换。
- 页面视觉自评（仅介绍页）：层级 9、间距 9、字体 9、颜色 9、信息密度 9、交互 9、状态 8、移动适配 9、品牌一致 9、可读性 9，均分 8.9/10。参考成熟产品的单焦点与渐进披露，沿用项目深色/金色令牌；浏览器三维画面验收独立记录。

视频新增段使用 CUA/CDP 原帧和原 timestamps；功能长片的历史段保留原旁白与字幕，新段更新女声旁白、内嵌字幕和完整外置 SRT/VTT。脚本固定 CPU libx264 两线程，输出章节、FFprobe、完整解码与 SHA-256；缺少新段实录时只准备 clip，不输出不完整终稿。

## 现有视频基线

以下系统片已被用户要求重新制作，保留作历史基线；新片按 `../assets/studio-020/intro-astra-180s-plan.md` 的单SMT因果故事推进。新EDL、19句自然语速旁白与39条实测发音字幕已准备，180秒连续素材尚未齐备。以下哈希不代表新版Astra成片。

产物目录：`D:/Documents/bim/deliverables/studio-020-20261007/`。两片均为 1920×1080、30 fps、H.264/AAC 48 kHz 双声道，MP4 faststart；各有外置中文 SRT/VTT 与逐章来源 `evidence.json`。

| 文件 | 时长 | 字节 | 章节 | SHA-256 |
| --- | ---: | ---: | ---: | --- |
| `deepmonkey-studio-intro.mp4` | 180.021 s | 24,021,462 | 7 | `3a2bd7b86f344238026d43678d738f6492c5fb63cd79a034354663f4ed57fcac` |
| `deepmonkey-studio-features.mp4` | 537.740 s | 40,234,077 | 27 | `9c0051089be65fa831e005db9121e2798743661eabada9499ee69bff22cf82dd` |

该历史系统片按三分钟工业产品短片剪辑，用户已要求按Astra规划重新制作；功能长片保持原字节。七章依次为理念与工业现场 18 秒、统一创作 26 秒、数据流程 24 秒、本体关系 28 秒、Agent 与行为 24 秒、渲染技术 32 秒、发布交付与 SDK 28 秒。真实 SMT 产线贯穿开场、创作、行为、技术与结尾；新增流程连线、本体配置、工业材质、时间线和 Agent 使用当前实录。原生工业连续录像来自 9 月正式录屏，不作为当前性能结果。

理念沿用产品已有的 Vibe World 定位。技术段区分 Three.js、Deep WebGPU 和 Deep WASM，并说明 WASM 与 Native 共用自研内核；介绍 PBR、分簇光照、阴影、探针 GI、GPU 剔除、实例化与 LOD。旁白全文见 `docs/assets/studio-020/intro-narration-180s.md`。Agent 展示任务与能力入口，关系配置取消未保存；本轮不交付 Android。284 秒旧版及首次 180 秒版分别保存在 `backup-intro-284s/` 和 `backup-intro-180s-initial/`。

功能长片由 `scripts/build-studio-020-videos.py` 合成；系统片由 `scripts/build-studio-020-intro.py` 合成，两者均通过 `ffmpeg -xerror` 整片解码。系统片使用 30 fps 原生录屏、38 px 短语字幕、短暂章标题与实录聚焦裁切；编码缓存覆盖录屏源字节、旁白、字幕、裁切与配置。两片字幕、章节、来源、MP4 与八项资产 SHA 校验通过，功能长片 SHA 保持不变。

新版第一轮检查发现 Director 转场空场和技术句字幕三行，第二轮已换回真实产线镜头并拆分分号短句。两轮关键帧见 `test-output/studio-pages-020/intro-industrial-r1-*.png` 与 `intro-industrial-r2-*.png`，最终 19 帧总览为 `intro-industrial-r2-contact.jpg`，首 32 秒审片为 `intro-industrial-first32-review.mp4`。整片响度 -18.64 LUFS、true peak -4.46 dBFS，无削波；日志 `intro-industrial-loudness.log`。

视觉自评（系统片）：层级 9、间距 9、字体 9、颜色 9、信息密度 9、操作呈现 9、状态 9、画面适配 9、品牌一致 9、可读性 9。参考 Unity 产品介绍的工业场景主线与 Siemens 的克制信息密度，沿用 Studio 深色/金色令牌。获奖是创作目标，影片交付依据为逐镜复核和编码检查。

## 静态浏览中间产物

独立 Vite SceneViewer 按 `/DeepMonkey-Studio/browse/` 构建，复用冻结正式发布包和已有资源闭包裁剪，不覆盖普通 Web dist 或 Tauri 配置。示例只有三个自产基础几何，零外部模型与资源。浏览 ZIP 为 8,794,884 bytes，SHA-256 `db82aefad47bc2fc4ad60b18ecd114e698436e2005b1c38eb869227c0385b545`；资源清单为 `test-output/studio-pages-020/final-site/pages-viewer-evidence.json`。

本地项目子路径实测进入“场景已就绪 · WEBGL”，三个对象可浏览，选择立柱显示七项属性，测量与剖切可切换；控制台无警告和错误，运行资源中的 `/api/` 请求为零。两轮对象/剖切截图为 `final-browser-round1.png` 与 `final-browser-round2.png`。介绍页实际播放功能长片 537.740 秒，切换视频后原播放器暂停；真实 404 源视频测试显示下载提示。首次发现 `source.error` 不冒泡导致加载文字持续，已同时监听视频与源错误，两片共用处理。桌面/移动 DOM 尺寸实测 1920/390，无横向溢出；完整主任务视觉复检及线上部署由最终发布检查确认。
