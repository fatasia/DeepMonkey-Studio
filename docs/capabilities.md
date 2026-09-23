# 功能清单

README 只列亮点，这里是目前可用的完整功能清单。清单以代码和验收门禁为准；发现与实际行为不符请提 Issue。

## 模型导入与转换

- 上传 RVT、IFC、STEP/STP、DWG、DXF、GLTF、GLB、FBX。
- IFC 在浏览器中通过 That Open Components 转为 Fragments；空间结构树可展开到 IFC 构件，并支持拾取、蓝色高亮、显隐、删除、颜色、透明度和属性查看。
- GLTF/GLB 通过 Three.js 直接加载，支持 `KHR_draco_mesh_compression` Draco 压缩模型。
- FBX 通过 Three.js FBXLoader 直接加载。
- STEP/STP 由 `occt-import-js`（Open CASCADE WASM）在 API 转换队列中三角化为 GLB，保留装配/零件目录、名称、颜色和几何统计，不要求安装 CAD 软件。
- DWG 由 GNU LibreDWG 转为 DXF 后复用基础二维线框查看器，保留常用实体和图层；加载时按 DXF 单位换算为米、选择模型空间并自动归中，避免绝对坐标造成相机漂移；复杂动态块、AEC/Civil 代理对象和高保真文字不在开源链路保证范围内。
- DXF 提供基础二维线框加载。
- RVT 通过自研 C# Revit Worker + Add-in 调用 Revit API；上传时可选“原生 GLB”或“IFC”链路，两种链路复用同一个常驻 Revit 进程。

### 转换器输出约定

RVT 转换器按上传时选择的链路，在输出目录生成 `geometry.glb` 或 `model.ifc`。原生链路还会生成规范化的 `hierarchy.json`、`properties.json` 和预压缩 `.gz`：完整 BIM 属性与几何分离，浏览器按 ElementId/UniqueId 重新关联；GLB 在发布前自动进行去重、焊接和 Draco 压缩。API 自动选择 Three.js 或 That Open Fragments 查看器。原生 GLB 是默认路线，IFC 是兼容备用路线。

先安装 Add-in 并发布 Worker：

```powershell
pnpm revit:install
```

转换机必须安装并许可相应版本的 Revit。首次 RVT 任务会启动 Revit；Add-in 就绪后持续监听作业目录，因此后续原生 GLB 与 IFC 任务不会重复打开 Revit。安装、目录和故障排查见 [Revit Worker 说明](../tools/revit-worker/README.md)。转换命令通过 `.env` 配置，API 使用 `spawn` 直接启动，不经过 shell。

STEP 不需要外部程序，`pnpm install` 后即可转换。Windows 上的 DWG 首次使用前安装开源转换器：

```powershell
pnpm dwg:install
```

脚本从 GNU LibreDWG 官方 GitHub Release 下载到 `tools/libredwg`，API 会自动发现 `dwg2dxf.exe`。已安装到其他目录时，可通过 `.env` 的 `DWG_CONVERTER_COMMAND` 覆盖。LibreDWG 输出的转换警告代表某些高级 DWG 对象可能被跳过；基础 CAD 浏览会继续使用成功生成的 DXF。

场景文件的内容、可移植性和生产路由回退要求见 [场景文件说明](scene-format.md)。DWG 与 STEP 的开源/商业导入路线、许可证影响和推荐架构见 [DWG/STEP 导入调研](dwg-step-import-research.md)。

## 项目与场景管理

- 项目可新建、切换、重命名和删除；模型、转换任务和场景状态按项目隔离持久化，一个场景可同时装载多个模型。
- 独立场景管理页按更新时间倒序排列，支持新建、复制、重命名、保存、删除；导出菜单提供零散 `.scene.json`、包含资源的 `.bimscene`，以及合并当前可见三维对象的 `.glb`。
- 场景支持直接只读浏览、发布稳定快照、重新发布和撤回；管理中心为 `/manager`，编辑器为 `/studio/:sceneId`，当前保存版浏览为 `/view/:sceneId`，发布版为 `/published/:sceneId`。

## 场景编辑与浏览

- 模型树可递归展开到内部节点，支持整模或内部图层显隐；并支持透明度、删除、移动、旋转、缩放。
- 模型/构件选择模式明确分离；内部图层可单独选择、移动、旋转、缩放、改名、调透明度及场景级删除。
- 模型和内部图层支持锁定；原生 RVT 元数据可提取房间/MEP Space，并按模型和楼层展开空间树、稳定定位、单项/楼层批量显隐空间体，右侧按类别结构化显示 BIM 属性。
- 可按名称、稳定 ID、属性、楼层和类别检索构件，并定位、隔离结果或恢复全场景。
- 基础立方体；距离、构件最小距离、角度、标高四种测量，带动态预览和结果定位；正方体与每条标尺都会进入左侧场景对象图层并可单独删除。
- 支持剖切盒、X/Y/Z 轴向剖切、拾取面剖切及方向反转；模型爆炸支持径向、垂直和各轴方向，状态随场景保存。
- 可为每个已加载模型和正方体单独开启 BVH 三角形硬碰撞检测，返回碰撞构件对和定位点，发生重合时对象显示稳定的红色高光。
- 轨道浏览、带碰撞和地面跟随的第一人称漫游、带角色跟随镜头的第三人称漫游。
- GLTF、GLB、FBX 内含的动画可按模型播放或暂停，状态随场景保存。
- 场景动画编辑器支持相机轨道与整个模型/立方体的关键帧，提供线性/平滑/曲线插值、播放速度、循环、往返、路径显示和关键帧删除，状态随场景保存。
- 标签标记可拾取模型表面或地面放置，支持名称、说明、颜色、尺寸、XYZ、显隐、锁定、定位和删除，并随场景保存、导入与导出。
- 构件可按 BIM 楼层整层显隐，并通过“向上展开”形成楼层分解视图；IFC Fragments 当前保证楼层显隐，逐层位移主要用于原生 GLB/RVT 模型。
- 场景管理中心提供 `/optimizer` 模型优化页，可在浏览器本地进行模型减面、Draco、贴图压缩、快速顶点色烘焙，以及基于 watlas 自动 UV2 的彩色 Web 光照贴图烘焙；支持 AO、软阴影、一次间接反弹、降噪、边缘扩张和草稿/标准/高质量档位，全部处理运行于可取消的 Worker，结果以标准 glTF 双贴图写入并导出 GLB。
- 环境控制支持晴天、下雨、下雪、网格显隐、可配置纯色背景、晴空/黄昏/夜空天空盒，以及全局灯光开关和强度调节，状态随场景保存。
- 灯光系统默认只保留一个主方向光，仍可按需添加环境光、半球光、点光源、聚光灯和矩形区域光；可移动的灯光代理与目标点直接显示在三维场景中；阴影、反射和近似全局光照默认关闭。
- WebGL 后处理支持 SMAA、FXAA、SSAO、GTAO、Bloom、选中轮廓、景深、暗角、胶片颗粒和残像，所有效果默认关闭并随场景保存；HDR/EXR 环境贴图和 PBR 材质参数也随场景保存。
- WebGL 模式支持 WebXR 的 VR/AR 会话入口；实际进入需要兼容设备以及 localhost 或 HTTPS 安全上下文。
- 场景信息开关按需统计模型、构件、三角面和顶点，并显示相机位置、观察目标及鼠标拾取坐标；默认关闭以减少持续拾取和统计开销。
- 提供上、下、左、右、前、后六个标准视角；当前模型或内部图层以蓝色包围框标识选中状态。
- 编辑页禁用浏览器默认右键菜单，右键保留给三维交互扩展。
- 中英文可在各主页面切换；开源致谢窗口列出核心项目、许可证和源码链接。

## 数据中心与看板

- 数据中心原生管理 HTTP、WebSocket、MQTT、AMQP、Kafka、CoAP、PostgreSQL、MySQL、Oracle、TDengine、OPC UA、Modbus TCP、BACnet、S7、EtherNet/IP、SNMP、TCP、UDP 和串口连接；Studio 直接绑定清洗后的数据集。
- Studio 内置 ECharts + GridStack 轻量看板，支持数值、仪表、趋势、面积、柱状、饼图、表格、状态、图片、本地视频、实时监控和网页；图片与视频统一进入项目资源库，RTSP、RTMP、SRT 等浏览器不能直接播放的地址会自动转换为 HLS 或 WebRTC 播放地址。
- 模型、图层、BIM 构件与二维看板组件共用可信事件脚本，支持加载、点击、鼠标进入/离开和动画开始/结束；脚本可直接访问 Three.js、ViewerEngine 与全部运行时对象。
- 二维看板保留手填数据键与自动补全，并支持嵌入 HTTP(S) 或站内 URL 网页组件；详细使用与多场景设计见 [看板交互与多场景](interactions-dashboard-and-multiscene.md)。

## 系统管理

- 内置简化用户与权限：管理员、编辑者、浏览者三种角色，非管理员按项目授权；系统管理页统一查看用户、服务健康度、错误/操作审计和 AI 配置。
- 独立全局设置页可替换 Logo、应用 Icon、系统名、浏览器标题、版权与主题色，并配置默认语言、登录入口、新场景背景/网格和维护模式；该页不出现在系统菜单中，仅管理员可通过 `/branding` 访问。

## AI 助手

- 支持可验证的 BIM 工程问答、场景问答、当前选中构件问答、只读 SQL 生成/解释，以及根据自然语言生成 ECharts + GridStack 看板方案；BIM 问答会先检索真实构件元数据与空间信息，再计算几何尺寸、坐标和轴对齐净空初筛，结果可直接定位/隔离构件或显示设备试放体；大模型兼容 Responses API 与 Chat Completions，并通过 SSE 流式显示结果。

## 视觉中心

- 视觉中心 `/vision` 统一管理图片、RTSP/RTMP/SRT/HLS 实时视频、ONNX 模型、识别任务和事件记录；识别结果可绑定场景模型，触发红色轮廓/辉光、相机定位和状态消息。
- YOLO 是视觉检测的一等模型格式：兼容 YOLOv5/v7 常见 `5+C`、YOLOv8/v10/v11 常见 `4+C`、特征前置/预测前置张量和已做 NMS 的 `Nx6` 输出；外部训练生成的 `.pt` 先导出 `.onnx`，平台负责推理、阈值、NMS、标签映射和 letterbox 坐标还原。
- 内置 Apache-2.0 的 YOLOX-Nano、SSD MobileNet、MobileNet V2 与 Pyronear 早期烟雾 ONNX 下载预设，并提供 PPE、火焰/烟雾、吸烟、打架/睡岗/跌倒、工业表面缺陷、异常 OK/NG、SOP 工序和 YOLO 通用 `manifest.json` 模板；业务权重由用户上传，不把来源不明或具有闭源冲突的模型打进商业发行包。
- 上手步骤见 [视觉 AI 上手](vision-quickstart.md)。

## 运行与配置

本地开发与生产部署统一使用 `pnpm studio`：

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
- 健康检查: http://localhost:4100/health

首次部署的管理员账号与密码均为 `admin`，可通过 `.env` 的 `BIM_STUDIO_ADMIN_PASSWORD` 修改初始密码。登录页勾选“下次自动登录”后使用 30 天签名会话，未勾选时仅在当前浏览器会话保存并于服务重启后失效；生产环境应配置稳定、随机的 `BIM_STUDIO_SESSION_SECRET`。登录后，管理员可从页面右下角“系统”进入用户授权、健康、审计和 AI 配置。AI 也可以直接由 `.env` 初始化：`AI_BASE_URL`、`AI_API_KEY`、`AI_MODEL`、`AI_PROTOCOL`、`AI_TEMPERATURE`；`AI_PROTOCOL` 可设为 `responses`、`chat-completions` 或 `auto`，页面保存后的配置优先于环境变量，API Key 不会回显到浏览器。

### PostgreSQL 与 MinIO

默认仍可使用本地 JSON 和本地文件。`METADATA_STORE=sqlite` 时使用 Node 24 内置 SQLite，适合单机；设置 `METADATA_STORE=postgres` 后，API 会初始化 PostgreSQL 状态表，并在首次启动时导入原有 `data/database.json`；设置 `OBJECT_STORE=minio` 后，会创建存储桶并迁移原有 `data/projects` 文件。连接参数参见 `.env.example`，迁移过程不会删除原文件，便于回退。
