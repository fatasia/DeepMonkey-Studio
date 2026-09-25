# 引擎能力盘点（2026-09-25）

范围：Deep Engine 核心、Native/WASM 运行时，以及 Studio 对引擎的消费能力。按能力族归并，不把每个 API、shader pass 或测试计为独立产品功能。

## 现状核查

### 已有（不重建）

- 已检查根目录与项目 AGENTS、近期 git log、git status（含未跟踪文件）和 diff stat；本次基线 HEAD 为 42258561，工作树存在大量并行改动，本报告描述工作树，不等于发布版本。
- 已检索 packages 与 apps 的引擎、capability、physics、animation、GI、ray、LOD、runtime package 等入口；读取 contracts 场景/格式合同、Deep 动画类型与公开导出、Native lib 模块及 Web rendererCapabilities。
- 已核对 deep-engine/package.json、deep-engine-native/Cargo.toml；现有 TypeScript/WebGPU、Three 桥、Rust/wgpu、Rapier 与字体/媒体依赖，不新增库。
- 已查消费链：compileSceneRuntimePackage、compileScenePhysicsRuntime、probeGridBakeRunner、Native renderer/init、runtime_package/payloads、作者命令层与 Three/WASM 桥。
- 已查测试文件、test-output 证据目录及工业、WASM、Native、Deep2D 报告；当前状态以最新总账和源码覆盖旧报告。此次没有重跑测试，不将历史绿灯标为当前工作树全量通过。
- 已读 active-task-recovery-ledger、工业格式权威计划、Deep Engine 综合计划及相关报告。AGENTS 指向的 engine-capability-expansion-plan-2026-09-22.md 在所列路径不存在，未据其推定能力状态。

### 真实缺口

- 文档版本不统一：README、Three 矩阵与 9 月 22 日报告部分结论已被后续实现覆盖。
- 底层模块、作者入口、Web/Native/WASM 消费与正式安装包验收不能互相替代。
- 作者态仍有 Three 依赖；命令层、gizmo、overlay 和帧循环解耦尚未整体完成。
- 工业格式、Deep2D 对等、XR 真机、Native 导航及性能比较仍有明确范围与验收缺口。

## 能力族清单

“已有”表示查到实现，不代表全部后端、任意数据及正式产物均验收完成。

| 能力族 | 当前实现范围 | 边界 |
|---|---|---|
| 运行后端 | Deep WebGPU、Rust/wgpu Native、WASM；Three/WebGL 兼容路径 | 作者态尚未完全脱离 Three |
| 后端生命周期 | 能力探测、候选呈现、切换、失败回退、偏好持久化、设备恢复 | 分宿主验证 |
| 场景与变换 | 稳定 ID、层级、TRS、矩阵、变化集、变换图、空间同步 | 作者命令迁移进行中 |
| 编辑操作 | 选择、显隐、锁定、隔离、分组、变换、多选、撤销重做 | 核心与 Studio 联合能力 |
| 几何与实例 | 网格、索引/属性、法线/切线、共享几何、实例化、增量更新、Meshlet | 具体资产特征严格校验 |
| PBR | GGX、金属粗糙度、IOR、法线、AO、发光、双面、镜像、透明/裁切 | 材质扩展非全覆盖 |
| 纹理 | UV0/UV1、变换、PNG/JPEG、HDR、KTX2/Basis、BC/ETC2/ASTC、mip | 解码/压缩格式依能力选择 |
| 灯光 | 环境/方向/局部光、IBL、辐照度、预过滤环境、DFG、IES、Forward+/cluster | 六类作者灯光不等于六类后端全对等 |
| 阴影 | PCF、CSM、局部聚光阴影、atlas、缓存、预算、LOD | 各材质/后端有限制 |
| GI 与烘焙 | 探针网格、clipmap、辐射生产、遮挡、relocation、采样、烘焙服务；静态 lightmap 桥 | 跨端质量/正式产物仍需逐项验收 |
| 光线查询 | BVH/TLAS、compute ray tracing、探针/SSR/阴影扩展、Native 硬件 ray query | 依 GPU；不等于完整路径追踪 |
| 后处理 | Bloom、AO、SSR、空间/时间 AA、曝光、ACES、调色、雾 | 管线模块与作者消费覆盖不同 |
| 环境与效果 | 天空/背景/网格、天气、体积雾、GPU 粒子、轮廓/辉光/XRay/扫描/热力/溶解/边缘光/火焰 | 部分由 Studio/Three 提供 |
| GPU 驱动 | 视锥、Hi-Z 遮挡、实例压缩、间接绘制、GPU LOD、Meshlet 剔除 | 可见性 buffer、软光栅等须保留实验范围 |
| 大场景 | chunk、驻留预算、预取、取消、原子发布、LOD/HLOD、世界分区、相机相对坐标 | 不据此声称任意开放世界成熟 |
| 渲染调度 | RenderGraph、资源生命周期/别名、帧边界提交、缓存、自适应质量 | Web 与 Native 执行层分开 |
| 相机与拾取 | orbit/pan/zoom、视角、飞行、Web 漫游、Deep pick、对象映射、空间查询 | Native 第一/第三人称尚非完整对等 |
| BIM 交互 | 构件树/属性、搜索、楼层、测量、剖切、爆炸、碰撞检测、标注 | Studio 集成能力，Native 覆盖另验 |
| 动画 | clip、seek、倍速、循环、关键帧、插值、混合/叠加、淡入淡出、状态机、路径约束、时间线 | 底层与作者入口分层 |
| 变形与机器人 | GPU skinning、Morph、融合变形、骨骼姿态、IK、机器人关节/限位 | IK/机器人主要属上层能力 |
| 物理 | Rapier、固定步进、静态/动态/运动学刚体、重力、摩擦、恢复系数、转动关节/马达、碰撞事件、Web 角色控制器 | Native 角色控制器存在降级 |
| Shader | DeepSL、typed IR、WGSL、计算 IR/双发射器、轻量图模块、Standard/Unlit、包/ABI、热更新/LKG、缓存 | 非全功能 Shader Graph/任意 GLSL 兼容 |
| Deep2D 与图表 | path/text/image/clip/hit-region、保留式 UI、字体/文本、ChartIR、六类图表、双轴、图例/tooltip/zoom、输入/筛选/表格/媒体 | 完整 Web GUI 对等仍需验收 |
| 数据与行为 | 数据绑定、运行时更新、事件脚本、行为 IR、播放/回放；SDK/扩展/MCP 上层接口 | 非全部由渲染核心独立提供 |
| 资产与发布 | glTF/GLB、自有运行包、资源哈希/闭包、预热、重导入、冻结发布、离线 ZIP、Windows Native/Three WebView、Android 路径 | 平台打包成功不代表能力全对等 |
| 诊断与性能 | CPU/GPU 时间、分位延迟、显存/驻留、帧捕获、源码映射、启动/设备诊断、画面和交互基准 | 不能宣称整体超过对手 |
| 行业扩展 | 道路/围栏/预制体；机器人、Plant/PS/PD Lite、工位与流程验证 | 上层业务模块，不等同完整工业套件 |

## 格式范围

常规资产链包括 glTF/GLB、OBJ、STL、FBX、IFC、STEP/IGES、DXF/DWG，以及 URDF/机器人包等入口；原生 Deep 解码子集与经过 Three/转换器标准化后的范围不同。OpenUSD、3MF、COLLADA、3DS、KMZ、PLM XML、QIF 等目录项须按实际 loader/provider/profile 判断，目录登记不算完成。

工业权威计划的 JT、X_T、RVT、E57/LAS/LAZ/COPC、3D Tiles、3DM、SolidWorks 七方向按独立质量报告验收。最近核查的 S1–S6 收口报告将点云保持 inspect、其他研究/受限 profile 保持 preview；不能直接写成通用 productionReady。

## 核验入口

- [最新总账](../active-task-recovery-ledger.md)
- [Deep Engine 公开导出](../../packages/deep-engine/src/index.ts)
- [Native 模块](../../packages/deep-engine-native/src/lib.rs)
- [场景合同](../../packages/contracts/src/scene.ts)
- [工业格式收口](industrial-s1-s6-closure-2026-09-18.md)
- [公平对比与作者态依赖](deep-fair-comparison-2026-09-25.md)

本次仅新增盘点文档，未修改产品代码、依赖、配置和并行工作文件。
