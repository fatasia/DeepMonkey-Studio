# Deep Monkey Studio

面向内网部署的 Web 原生工业数字孪生、仿真验证与可视化应用平台。BIM/CAD 是工程资产输入而非产品主线；格式能力采用可插拔转换器架构，浏览器不会假装直接解析 RVT 或 DWG。

## 当前能力

- 上传 RVT、IFC、STEP/STP、DWG、DXF、GLTF、GLB、FBX
- IFC 在浏览器中通过 That Open Components 转为 Fragments；空间结构树可展开到 IFC 构件，并支持拾取、蓝色高亮、显隐、删除、颜色、透明度和属性查看
- GLTF/GLB 通过 Three.js 直接加载，并支持 `KHR_draco_mesh_compression` Draco 压缩模型
- FBX 通过 Three.js FBXLoader 直接加载
- STEP/STP 由 `occt-import-js`（Open CASCADE WASM）在 API 转换队列中三角化为 GLB，保留装配/零件目录、名称、颜色和几何统计，不要求安装 CAD 软件
- DWG 由 GNU LibreDWG 转为 DXF 后复用基础二维线框查看器，保留常用实体和图层；加载时按 DXF 单位换算为米、选择模型空间并自动归中，避免绝对坐标造成相机漂移；复杂动态块、AEC/Civil 代理对象和高保真文字不在开源链路保证范围内
- DXF 提供基础二维线框加载
- RVT 通过自研 C# Revit Worker + Add-in 调用 Revit API；上传时可选“原生 GLB”或“IFC”链路，两种链路复用同一个常驻 Revit 进程
- 项目可新建、切换、重命名和删除；模型、转换任务和场景状态按项目隔离持久化，一个场景可同时装载多个模型
- 模型树可递归展开到内部节点，支持整模或内部图层显隐；并支持透明度、删除、移动、旋转、缩放
- 基础立方体；距离、构件最小距离、角度、标高四种测量，带动态预览和结果定位；正方体与每条标尺都会进入左侧场景对象图层并可单独删除
- 轨道浏览、带碰撞和地面跟随的第一人称漫游、带角色跟随镜头的第三人称漫游
- 独立场景管理页按更新时间倒序排列，支持新建、复制、重命名、保存、删除；导出菜单提供零散 `.scene.json`、包含资源的 `.bimscene`，以及合并当前可见三维对象的 `.glb`
- 场景支持直接只读浏览、发布稳定快照、重新发布和撤回；管理中心为 `/manager`，编辑器为 `/studio/:sceneId`，当前保存版浏览为 `/view/:sceneId`，发布版为 `/published/:sceneId`
- 模型/构件选择模式明确分离；内部图层可单独选择、移动、旋转、缩放、改名、调透明度及场景级删除
- 可按名称、稳定 ID、属性、楼层和类别检索构件，并定位、隔离结果或恢复全场景
- 支持剖切盒、X/Y/Z 轴向剖切、拾取面剖切及方向反转；模型爆炸支持径向、垂直和各轴方向，状态随场景保存
- 可为每个已加载模型和正方体单独开启 BVH 三角形硬碰撞检测，返回碰撞构件对和定位点，发生重合时对象显示稳定的红色高光
- GLTF、GLB、FBX 内含的动画可按模型播放或暂停，状态随场景保存
- 场景动画编辑器支持相机轨道与整个模型/立方体的关键帧，提供线性/平滑/曲线插值、播放速度、循环、往返、路径显示和关键帧删除，状态随场景保存
- 模型和内部图层支持锁定；原生 RVT 元数据可提取房间/MEP Space，并按模型和楼层展开空间树、稳定定位、单项/楼层批量显隐空间体，右侧按类别结构化显示 BIM 属性
- 标签标记可拾取模型表面或地面放置，支持名称、说明、颜色、尺寸、XYZ、显隐、锁定、定位和删除，并随场景保存、导入与导出
- 场景管理中心提供 `/optimizer` 模型优化页，可在浏览器本地进行模型减面、Draco、贴图压缩、快速顶点色烘焙，以及基于 watlas 自动 UV2 的彩色 Web 光照贴图烘焙；支持 AO、软阴影、一次间接反弹、降噪、边缘扩张和草稿/标准/高质量档位，全部处理运行于可取消的 Worker，结果以标准 glTF 双贴图写入并导出 GLB
- 环境控制支持晴天、下雨、下雪、网格显隐、可配置纯色背景、晴空/黄昏/夜空天空盒，以及全局灯光开关和强度调节，状态随场景保存
- 灯光系统默认只保留一个主方向光，仍可按需添加环境光、半球光、点光源、聚光灯和矩形区域光；可移动的灯光代理与目标点直接显示在三维场景中；阴影、反射和近似全局光照默认关闭
- WebGL 后处理支持 SMAA、FXAA、SSAO、GTAO、Bloom、选中轮廓、景深、暗角、胶片颗粒和残像，所有效果默认关闭并随场景保存；HDR/EXR 环境贴图和 PBR 材质参数也随场景保存
- 构件可按 BIM 楼层整层显隐，并通过“向上展开”形成楼层分解视图；IFC Fragments 当前保证楼层显隐，逐层位移主要用于原生 GLB/RVT 模型
- WebGL 模式支持 WebXR 的 VR/AR 会话入口；实际进入需要兼容设备以及 localhost 或 HTTPS 安全上下文
- 中英文可在各主页面切换；开源致谢窗口列出核心项目、许可证和源码链接
- 数据中心统一管理 HTTP、WebSocket、MQTT、AMQP、Kafka、CoAP、PostgreSQL、MySQL、Oracle、TDengine、OPC UA、Modbus TCP、BACnet、S7、EtherNet/IP、SNMP、TCP、UDP 和串口连接；流程服务负责协议采集，Studio 只绑定清洗后的数据集
- Studio 内置 ECharts + GridStack 轻量看板，支持数值、仪表、趋势、面积、柱状、饼图、表格、状态、图片、本地视频、实时监控和网页；图片与视频统一进入项目资源库，RTSP、RTMP、SRT 等浏览器不能直接播放的地址会自动转换为 HLS 或 WebRTC 播放地址
- 模型、图层、BIM 构件与二维看板组件共用可信事件脚本，支持加载、点击、鼠标进入/离开和动画开始/结束；脚本可直接访问 Three.js、ViewerEngine 与全部运行时对象
- 内置简化用户与权限：管理员、编辑者、浏览者三种角色，非管理员按项目授权；系统管理页统一查看用户、服务健康度、错误/操作审计和 AI 配置
- 独立全局设置页可替换 Logo、应用 Icon、系统名、浏览器标题、版权与主题色，并配置默认语言、登录入口、新场景背景/网格和维护模式；该页不出现在系统菜单中，仅管理员可通过 `/branding` 访问
- AI 助手支持可验证的 BIM 工程问答、场景问答、当前选中构件问答、只读 SQL 生成/解释，以及根据自然语言生成 ECharts + GridStack 看板方案；BIM 问答会先检索真实构件元数据与空间信息，再计算几何尺寸、坐标和轴对齐净空初筛，结果可直接定位/隔离构件或显示设备试放体；大模型兼容 Responses API 与 Chat Completions，并通过 SSE 流式显示结果
- 视觉中心 `/vision` 统一管理图片、RTSP/RTMP/SRT/HLS 实时视频、ONNX 模型、识别任务和事件记录；识别结果可绑定场景模型，触发红色轮廓/辉光、相机定位和状态消息
- YOLO 是视觉检测的一等模型格式：兼容 YOLOv5/v7 常见 `5+C`、YOLOv8/v10/v11 常见 `4+C`、特征前置/预测前置张量和已做 NMS 的 `Nx6` 输出；外部训练生成的 `.pt` 先导出 `.onnx`，平台负责推理、阈值、NMS、标签映射和 letterbox 坐标还原
- 内置 Apache-2.0 的 YOLOX-Nano、SSD MobileNet、MobileNet V2 与 Pyronear 早期烟雾 ONNX 下载预设，并提供 PPE、火焰/烟雾、吸烟、打架/睡岗/跌倒、工业表面缺陷、异常 OK/NG、SOP 工序和 YOLO 通用 `manifest.json` 模板；业务权重由用户上传，不把来源不明或具有闭源冲突的模型打进商业发行包
- 二维看板保留手填数据键与自动补全，并支持嵌入 HTTP(S) 或站内 URL 网页组件；详细使用与多场景设计见 `docs/interactions-dashboard-and-multiscene.md`
- 场景信息开关按需统计模型、构件、三角面和顶点，并显示相机位置、观察目标及鼠标拾取坐标；默认关闭以减少持续拾取和统计开销
- 提供上、下、左、右、前、后六个标准视角；当前模型或内部图层以蓝色包围框标识选中状态
- 编辑页禁用浏览器默认右键菜单，右键保留给三维交互扩展

## 从零启动

项目要求 Node.js 24，包管理器版本由根目录 `packageManager` 固定。首次克隆后只需要一个公开运行入口：

```bash
corepack enable
corepack prepare pnpm@11.18.0 --activate
pnpm install --frozen-lockfile
pnpm studio start client  # Windows：API + Web + 桌面开发客户端
pnpm studio start web     # Windows / Linux：API + Web
```

关闭、重启、状态和健康检查分别使用 `pnpm studio stop`、`pnpm studio restart`、`pnpm studio status`、`pnpm studio check`。API 可独立以 `pnpm studio start api` 启动；主机、端口、远程 API 和存储模式均可通过同一命令配置。完整的环境准备、本地零依赖模式、PostgreSQL/MinIO、生产部署、升级回滚与排障见 [从零开发与原生部署](docs/native-deployment.md)。

## 视觉 AI 快速使用

1. 从场景管理页进入“视觉中心”。首次验证目标检测可安装 YOLOX-Nano 或 SSD MobileNet；图片分类链路可安装 MobileNet V2；烟雾告警链路可安装 Pyronear，但室内工厂场景仍须使用现场数据验证。
2. 自有 YOLO 模型在训练环境导出 ONNX，例如 Ultralytics CLI 使用 `yolo export model=best.pt format=onnx imgsz=640 dynamic=False`。从“YOLOv5–v11 通用检测模板”下载清单并把 `labels` 改成训练时的准确类别顺序。
3. 上传 `model.onnx` 与 `manifest.json`。服务端会真实加载模型并检查输入节点，不通过的模型不会进入可选任务列表。
4. 创建任务时选择推理设备：“自动（GPU 优先）”会先尝试 Windows DirectML，初始化或运行失败时自动回退 CPU；也可以强制选择“GPU · DirectML”或“CPU”。单显卡设备编号保持 `0`，多显卡按系统枚举顺序填写。任务卡会显示实际运行设备、单次推理耗时和实际 FPS。
5. 图片质检：创建“图片识别”任务，在任务页上传 JPG/PNG/WebP/BMP/TIFF，查看框选、类别、置信度与耗时。
6. 实时识别：先添加视频源，再创建“实时视频”任务，设置推理 FPS、置信度、告警类别和冷却时间。RTSP/RTMP/SRT 可由实时视频服务转为浏览器可播放地址，推理 Worker 直接抽帧。
7. 三维联动：任务中选择场景并填写模型 ID；内部图层使用 `模型ID/图层ID`。新告警会在已打开的 Studio/浏览页中高亮并定位目标。

平台运行 ONNX，不直接运行训练检查点 `.pt`。模型清单中的输入尺寸、RGB/BGR、归一化、类别顺序和输出格式必须与导出模型一致。Windows GPU 推理使用 ONNX Runtime DirectML，可兼容主流 DirectX 12 显卡；DirectML 会话按任务串行执行，防止同一会话并发造成不稳定。

本地开发与生产部署统一使用 `pnpm studio`，不再维护平台专用的公开启动脚本：

```bash
pnpm studio start client
pnpm studio start web --api-port 4200 --web-port 5200
pnpm studio start api --metadata-store postgres --object-store minio
pnpm studio restart
pnpm studio stop
pnpm studio check
pnpm studio deploy --check
pnpm studio deploy
pnpm studio undeploy
```

`client` 当前仅支持 Windows，且开发 Web 端口固定为 5173；Linux 服务器使用 `web`、`api` 或 `deploy`。启动器只关闭自己管理且身份校验通过的进程，运行状态写入 `data/runtime`，聚合日志写入 `data/logs/studio.*.log`。

- Web: http://localhost:5173（默认监听 `0.0.0.0`，也可通过本机局域网 IP 访问）
- HTTPS Web: https://localhost:5173（设置 `BIM_STUDIO_HTTPS=true` 或为启动命令添加 `--https`）
- 独立全局品牌设置: http://localhost:5173/branding（HTTPS 模式下使用同路径）
- 实时监控播放: HTTPS HLS `:8888` / WebRTC `:8889`（页面不暴露底层转协议服务）
- API: http://localhost:4100
- Node-RED 流程编辑器: http://localhost:5173/node-red/
- Node-RED Dashboard: http://localhost:5173/iot/dashboard/
- 健康检查: http://localhost:4100/health

首次部署的管理员账号与密码均为 `admin`，可通过 `.env` 的 `BIM_STUDIO_ADMIN_PASSWORD` 修改初始密码。登录页勾选“下次自动登录”后使用 30 天签名会话，未勾选时仅在当前浏览器会话保存并于服务重启后失效；生产环境应配置稳定、随机的 `BIM_STUDIO_SESSION_SECRET`。登录后，管理员可从页面右下角“系统”进入用户授权、健康、审计和 AI 配置。AI 也可以直接由 `.env` 初始化：`AI_BASE_URL`、`AI_API_KEY`、`AI_MODEL`、`AI_PROTOCOL`、`AI_TEMPERATURE`；`AI_PROTOCOL` 可设为 `responses`、`chat-completions` 或 `auto`，页面保存后的配置优先于环境变量，API Key 不会回显到浏览器。

Node-RED 不运行不会影响模型浏览、编辑和场景保存；需要流程服务时按 [从零开发与原生部署](docs/native-deployment.md) 配置为外部原生服务。HTTP 场景桥为 `POST /iot/scene`，浏览器订阅 `/iot/ws/scene`。生产部署应设置随机 `NODE_RED_CREDENTIAL_SECRET`，并通过 Node-RED credential store 保存数据库与设备密码。

TDengine 与 Oracle 的最小可用示例流位于 `apps/node-red/examples/tdengine-oracle-dashboard.json`，并默认内置在 `flows.json` 中但保持禁用。连接参数由仓库根目录 `.env` 注入；Oracle 的用户名和密码通过被 Git 忽略的 `apps/node-red/flows_cred.json` 引用环境变量，也可以在 Node-RED 中双击“Oracle 示例连接”覆盖并加密保存。重启 Node-RED 后启用对应流程即可手动测试。TDengine 示例默认使用官方 `@tdengine/websocket` 连接 taosAdapter，查询失败会自动回退 `/rest/sql`；Oracle 示例使用 `node-red-contrib-oracledb-mod`，Oracle 12.1+ 保持默认 Thin 模式即可，Oracle 11g 或需要 Thick 特性时使用已安装到 `D:\Documents\bim\oracle\instantclient_19_31` 的 Instant Client。两个示例都直接输出到现有 `/iot/dashboard/` 看板。

## PostgreSQL 与 MinIO

默认仍可使用本地 JSON 和本地文件。设置 `METADATA_STORE=postgres` 后，API 会初始化 PostgreSQL 状态表，并在首次启动时导入原有 `data/database.json`；设置 `OBJECT_STORE=minio` 后，会创建存储桶并迁移原有 `data/projects` 文件。连接参数参见 `.env.example`，迁移过程不会删除原文件，便于回退。

## 转换器输出约定

RVT 转换器按上传时选择的链路，在输出目录生成 `geometry.glb` 或 `model.ifc`。原生链路还会生成规范化的 `hierarchy.json`、`properties.json` 和预压缩 `.gz`：完整 BIM 属性与几何分离，浏览器按 ElementId/UniqueId 重新关联；GLB 在发布前自动进行去重、焊接和 Draco 压缩。API 自动选择 Three.js 或 That Open Fragments 查看器。原生 GLB 是默认路线，IFC 是兼容备用路线。

先安装 Add-in 并发布 Worker：

```powershell
pnpm revit:install
```

转换机必须安装并许可相应版本的 Revit。首次 RVT 任务会启动 Revit；Add-in 就绪后持续监听作业目录，因此后续原生 GLB 与 IFC 任务不会重复打开 Revit。安装、目录和故障排查见 [Revit Worker 说明](tools/revit-worker/README.md)。转换命令通过 `.env` 配置，API 使用 `spawn` 直接启动，不经过 shell。

STEP 不需要外部程序，`pnpm install` 后即可转换。Windows 上的 DWG 首次使用前安装开源转换器：

```powershell
pnpm dwg:install
```

脚本从 GNU LibreDWG 官方 GitHub Release 下载到 `tools/libredwg`，API 会自动发现 `dwg2dxf.exe`。已安装到其他目录时，可通过 `.env` 的 `DWG_CONVERTER_COMMAND` 覆盖。LibreDWG 输出的转换警告代表某些高级 DWG 对象可能被跳过；基础 CAD 浏览会继续使用成功生成的 DXF。

场景文件的内容、可移植性和生产路由回退要求见 [场景文件说明](docs/scene-format.md)。第三方组件许可证见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

DWG 与 STEP 的开源/商业导入路线、许可证影响和推荐架构见 [DWG/STEP 导入调研](docs/dwg-step-import-research.md)。

与商业 BIM 平台的功能差距和推荐开发顺序见 [商业 BIM 平台功能差距分析](docs/commercial-bim-gap-analysis.md)。
