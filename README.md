# BIM Studio

面向内网部署的轻量 BIM/CAD 场景编辑器。项目采用可插拔转换器架构，浏览器不会假装直接解析 RVT 或 DWG。

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
- 场景管理中心提供 `/optimizer` 模型优化页，可在浏览器本地进行模型减面、Draco、贴图压缩、原点调整、重复点焊接、无用数据清理和 GLB 导出
- 环境控制支持晴天、下雨、下雪、网格显隐、可配置纯色背景、晴空/黄昏/夜空天空盒，以及全局灯光开关和强度调节，状态随场景保存
- 场景信息开关按需统计模型、构件、三角面和顶点，并显示相机位置、观察目标及鼠标拾取坐标；默认关闭以减少持续拾取和统计开销
- 提供上、下、左、右、前、后六个标准视角；当前模型或内部图层以蓝色包围框标识选中状态
- 编辑页禁用浏览器默认右键菜单，右键保留给三维交互扩展

## 启动

```powershell
pnpm install
pnpm dev
```

Windows 也可以使用根目录服务脚本统一管理全部服务，或只操作一个服务：

```powershell
.\bim-studio.ps1 start all
.\bim-studio.ps1 restart api
.\bim-studio.ps1 stop web
.\bim-studio.ps1 status all
```

服务脚本会把项目临时文件写入仓库内的 `.cache` 目录；Revit Worker 可通过 `BIM_STUDIO_WORKER_ROOT` 指定数据盘缓存位置。`.cache`、`data`、日志、模型测试文件和构建产物均不会提交到 Git。

- Web: http://localhost:5173
- API: http://localhost:4100
- 健康检查: http://localhost:4100/health

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

与 BIMFACE 当前公开能力的功能差距和推荐开发顺序见 [BIMFACE 功能差距分析](docs/bimface-gap-analysis.md)。
