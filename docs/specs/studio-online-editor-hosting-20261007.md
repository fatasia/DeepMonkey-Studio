# Pages 完整编辑器部署

## 2026-10-08 发布更新

按用户后续要求，0.2.0 公开部署采用浏览器本地工作台：复用 `DesktopLocalApi` 与 IndexedDB，隔离 Pages 数据库，初始化 SMT 冻结场景、275 项真实素材及 30 行演示数据。无需配置公网 API；服务端能力仍按下述独立部署方案运行。已核对项目/场景/应用契约、素材导入消费及存储测试，已有能力不重建。真实缺口是静态初始化、本地素材导入、数据预览和后台轮询隔离；由显式 Pages meta 启用，普通入口保留原行为。验证和部署证据见本轮发行记录。

用户要求在Pages页面内体验完整编辑器，按最新顺序在Deep真实验收后发布。本轮实现可配置浏览器API origin与Web base，准备隔离前端/服务端配置；不部署外网，不使用现有私有4100服务作为公开后端，README只读。

## 现状核查

1. 已搜索Web/API/contracts、未跟踪文件、Pages workflow与Docker配置中的API origin、子路径、资产、WebSocket、登录关键词。已有媒体/只读样例部署不能算完整编辑器。
2. `ServerProfile.baseUrl`、ServerClient、BrowserHostAdapter和SceneDataSocket契约已存在；所有API已有真实消费，浏览器profile缺省为location.origin。
3. React/Vite/Fastify、CORS/static/websocket、PostgreSQL/MinIO依赖已在用；Docker正式镜像已包含Web/API与现有worker。
4. BrowserHostAdapter→runtimeHost→ServerClient为HTTP边界；场景/直连WebSocket读取该profile；appRoute、bootstrapRoute和main直接读根pathname；模型/图像URL来自API。
5. 已查HostAdapter、ServerClient、appRoute、SceneDataSocket、productionWeb测试及Docker真实上传/发布/重启验证脚本。复用其消费链，新增分源与base合同检查。
6. 已核对Pages规格、在线指南、Docker/SDK发行规格、Astra视频准备和本轮最新顺序。外部服务域名、容量和公开演示权限尚未配置。

**已有（不重建）**：完整编辑器、API和持久化、生产Web、Docker服务、鉴权与WS、只读静态发布链。

**真实缺口**：Pages子路径路由/刷新、独立API origin、对应来源隔离的登录令牌、资产URL消费、独立服务配置及真实分源编辑验收。仅入口跳转不足以满足本轮目标。

## 实现与验收

配置静态前端base `/DeepMonkey-Studio/` 与独立API origin，默认同源和根路由保持。HTTP/WS和API管理的模型资源使用服务origin；静态JS/CSS/WASM使用Web base。认证令牌按明确服务origin隔离，不从同源旧登录借用到另一个API。场景/本体/Agent等实际功能继续调用既有接口。

正式后端使用独立Compose项目与默认作用域卷，初期只监听127.0.0.1:44100，数据库和对象存储不映射宿主端口。生产HTTPS反代只转发独立服务，保留路径与WebSocket协议。公开部署在Deep验收后配置。

本轮轻量验证：base下读写路由、API origin合法性、登录隔离、HTTP/WS/资产方向、配置解析；随后用本地静态前端子路径与独立服务运行登录、创建/保存/重载、流程、本体、上传资源与发布。3D及全部功能人工验收仍由最终真实浏览器测试确认。

## 当前证据

- Web分源合同与Host/路由/WS/公开应用/冻结依赖、文档导航、复制发布入口回归94项通过（13文件）；普通根base和默认同源行为保持。最终Web类型检查通过，全仓9,019个源文件通过800行门禁。
- 三次独立Vite完整编辑器构建成功，最新输出为 `test-output/studio-full-editor-hosting/frontend-20261007-r3`，base `/DeepMonkey-Studio/`，API `http://localhost:44100`，输出不覆盖生产dist；静态开发页裁剪使用既有脚本的输出目录参数。
- 独立Compose配置真实解析通过：3项目作用域卷、仅127.0.0.1:44100、无数据库/存储宿主端口。
- 2026-10-07 21:32 本地分源完整检查通过：静态路径/刷新、CORS预检/登录、GLB上传转换与MinIO字节核对、保存/重读/发布、12行真实处理、本体图查询、鉴权跨源WS事件。发布使用实际expectedSnapshot合同；首次重跑沿用旧测试卷时服务unhealthy，改为每轮独立Compose项目与卷后通过。首次容器日志未保留，不把凭据冲突推断记为已证实根因。
- 完整前端731文件的树SHA-256为 `7bc9decc1bb66f319babffbc3441dd410a68a8de4e872501480bbfa909cbd78f`。报告和身份在 `test-output/studio-full-editor-hosting/live-qa-20261007/report.json` / `source-identity.json`；API使用本地0.2.0镜像，首次脚本未存容器镜像ID，不把测试后观察的标签摘要当最终发行身份。
- 此轮owned测试容器、网络与卷已清理。GPU浏览器完整UI验收、最终公网域名、容量与演示权限待主任务安排，Deep优先。操作指南见 `docs/guides/full-editor-hosting.md`。
