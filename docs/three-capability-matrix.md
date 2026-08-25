# Three.js 等价能力门禁矩阵

> 基线：`three@0.184.0`（Three.js `r184`）  
> 矩阵版本：`0.1-draft`  
> 适用里程碑：M4–M6  
> 最后核对：2026-08-25

## 1. 门禁目标与边界

本矩阵把“能直接用 Three.js 文档化公开能力写出来的功能，在 Dev Studio 中也能简单实现”变成可持续检查的发布门禁。通过门禁必须同时满足：

1. 使用 Editor、`@bim-studio/scene-sdk` 或签名 Scene Extension，不修改编辑器核心代码；
2. 高频任务有可发现、可预览、可撤销的编辑器路径，长尾能力有稳定、带类型的扩展路径；
3. 示例不导入 `ViewerEngine`、Three Adapter、React 状态或其他私有模块；
4. 有自动化合同证据；涉及视觉或交互时，还必须有真实浏览器证据；
5. WebGPU 与 WebGL 2 使用同一业务语义；不支持时给出明确诊断和降级，不能静默丢失效果。

它不是 Three.js 所有类和方法的逐项复制清单。每一行代表一个可维护的“能力族”，并用代表性 Three.js API 界定边界。Three.js 基线由 [`apps/web/package.json`](../apps/web/package.json) 与 `pnpm-lock.yaml` 中的精确版本共同锁定；上游依据只接受 [Three.js `r184` 官方发布](https://github.com/mrdoob/three.js/releases/tag/r184)、[官方 `r184` 源码](https://github.com/mrdoob/three.js/tree/r184)、[官方 API 文档](https://threejs.org/docs/) 和[官方手册](https://threejs.org/manual/)。

## 2. 字段与状态定义

| 字段 | 含义 |
| --- | --- |
| ID | 稳定能力族编号；测试、问题、样例和 PR 都引用它，不能随意复用 |
| 能力族 | 用户要完成的能力，以及代表性的 Three.js 公开边界；不是内部实现细节 |
| 平台路径 | `Editor`、`Scene SDK`、`Scene Extension` 中计划作为长期公开面的入口 |
| 当前状态 | 只能取 `implemented`、`partial`、`planned`、`environment-blocked` |
| 当前证据 | 当前仓库中可复核的代码或测试；“存在内部 Three.js 调用”最多证明 `partial` |
| M4 退出证据 | 必须补齐的合同、样例、CI 或浏览器证据；`—` 表示该项不要求 M4 完成 |

状态判定：

- `implemented`：公开路径已经可用；代表性样例不改核心即可完成；合同测试已通过；视觉/交互能力另有真实浏览器证据。
- `partial`：只覆盖子集、仅存在于内部引擎，或缺少公开路径、样例、编辑体验、回退和验收证据中的任一项。
- `planned`：只有设计/路线图，当前仓库没有可运行实现证据。
- `environment-blocked`：平台实现和自动化合同已经齐备，但指定浏览器、GPU 或宿主确实不提供底层能力。必须附环境探针原始结果、用户可见诊断和降级路径；不能用它表示“尚未封装”。

证据标识：

- `CT-*`：TypeScript/协议/合同测试；`UT-*`：纯逻辑或引擎单元测试。
- `EX-*`：只依赖公开 API 的可运行示例；`CI-*`：架构、类型、构建、性能或视觉门禁。
- `BR-WGL-*` / `BR-WGPU-*`：真实浏览器 WebGL 2 / WebGPU 任务记录，包括目标版本、GPU/驱动、截图、控制台和结果文件。
- `DX-*`：首次使用与专业工作流记录，包括主操作数、上下文切换数、失败恢复和代码量。
- 下表中的 `待建` 是明确缺失，不等于通过。

## 3. Three.js `r184` 能力族矩阵

### 3.1 场景、对象、变换与层级

官方边界：[Scene](https://threejs.org/docs/pages/Scene.html)、[Object3D](https://threejs.org/docs/pages/Object3D.html)、[Group](https://threejs.org/docs/pages/Group.html)。

| ID | 能力族 | 平台路径 | 当前状态 | 当前证据 | M4 退出证据 |
| --- | --- | --- | --- | --- | --- |
| SCN-01 | 场景创建、清空、背景/环境、遍历与生命周期 | Editor + Scene SDK | partial | `ViewerEngine.scene`、环境配置、清空与 `scene.ready/disposed` 协议；SDK 尚无完整场景查询/修改宿主 | `CT-SCN-01`、`EX-M4-OBJ`、`BR-*-SCN-01` 待建 |
| SCN-02 | 稳定 ID 的对象创建、克隆、删除、搜索、批量查询与属性 | Editor + Scene SDK | partial | 已有模型/Primitive、场景组织、删除和 `object.search/get` 协议；公开命令未覆盖创建/克隆/删除/属性 | `CT-SCN-02`、`EX-M4-OBJ`、`DX-SCN-02` 待建 |
| SCN-03 | 选择、可见、锁定、隔离、选择集与批量操作 | Editor + Scene SDK | partial | 编辑器已有选择、显隐、锁定、隔离及选择集；SDK 只有选择和显隐命令子集 | 公开批量命令、撤销合同与 `BR-*-SCN-03` 待建 |
| TRN-01 | position/rotation/quaternion/scale、局部/世界变换与矩阵更新 | Editor + Scene SDK | partial | TransformControls、模型 Transform 保存和 `object.set-transform`；未公开 quaternion、matrix 和 local/world 转换 | `CT-TRN-01`、`EX-M4-OBJ` 待建 |
| TRN-02 | add/remove/attach、父子重挂、层级遍历与世界坐标保持 | Editor + Scene SDK | planned | 引擎会消费导入模型层级，但没有公开重挂/遍历接口和编辑器工作流 | `CT-TRN-02`、层级撤销、`EX-M4-OBJ` 待建 |
| TRN-03 | lookAt、坐标轴/枢轴、包围盒中心和约束式变换 | Editor + Scene SDK | partial | fit、拆解、灯光目标和包围盒内部实现已存在；没有统一公开对象能力 | `CT-TRN-03`、`EX-M4-EXPLODE` 待建 |

### 3.2 相机与控制器

官方边界：[Camera](https://threejs.org/docs/pages/Camera.html)、[PerspectiveCamera](https://threejs.org/docs/pages/PerspectiveCamera.html)、[OrthographicCamera](https://threejs.org/docs/pages/OrthographicCamera.html) 及官方 addons 控制器。

| ID | 能力族 | 平台路径 | 当前状态 | 当前证据 | M4 退出证据 |
| --- | --- | --- | --- | --- | --- |
| CAM-01 | 透视/正交投影、position/target/up、FOV、zoom、near/far | Editor + Scene SDK | partial | 当前为 PerspectiveCamera；相机位置、目标、FOV、near/far 已保存，SDK 有 `camera.set/get`；正交投影未见实现 | `CT-CAM-01`、双投影保存刷新、`BR-*-CAM-01` 待建 |
| CAM-02 | fit、flyTo、lookAt、标准视图、视角书签和镜头切换 | Editor + Scene SDK | partial | fitAll、标准视图、相机状态和 `camera.fly-to` 协议存在；缺公开宿主闭环与迁移样例 | `EX-M4-CAM-RAY`、`DX-CAM-02` 待建 |
| CAM-03 | 轨道、漫游、第一人称、第三人称与输入映射 | Editor + Scene SDK | partial | OrbitControls、PointerLockControls、第一/第三人称导航和设置面板已在引擎；SDK 尚无控制器命令/查询 | `CT-CAM-03`、`EX-M4-FPS`、`BR-*-CAM-03` 待建 |
| CAM-04 | 角色碰撞、重力/地面吸附、台阶/斜坡、连续防穿透与出生点恢复 | Editor + Scene Extension | partial | 已有碰撞半径、地面检测、滑墙/脱困和调试视图实现；黄金场景压力证据未齐 | `EX-M4-FPS` 与薄墙/台阶/低帧率 `BR-*-CAM-04` 待建 |
| CAM-05 | 世界/视图/裁剪/屏幕坐标互转与相机射线 | Scene SDK | planned | 引擎内部可借 Three.js 数学完成，未形成公开 API | `CT-CAM-05`、`EX-M4-CAM-RAY` 待建 |

### 3.3 几何、Mesh、材质与纹理

官方边界：[BufferGeometry](https://threejs.org/docs/pages/BufferGeometry.html)、[BufferAttribute](https://threejs.org/docs/pages/BufferAttribute.html)、[Mesh](https://threejs.org/docs/pages/Mesh.html)、[Material](https://threejs.org/docs/pages/Material.html)、[Texture](https://threejs.org/docs/pages/Texture.html)。

| ID | 能力族 | 平台路径 | 当前状态 | 当前证据 | M4 退出证据 |
| --- | --- | --- | --- | --- | --- |
| GEO-01 | Box/Sphere/Cylinder/Cone/Torus/Plane/Capsule 等基础几何创建与参数编辑 | Editor + Scene SDK | partial | 编辑器/引擎可创建七类 Primitive；SDK 只有 `studio.mesh` 能力声明，无创建命令 | `CT-GEO-01`、`EX-M4-MESH`、`BR-*-GEO-01` 待建 |
| GEO-02 | 自定义 BufferGeometry、attributes/index/groups、法线/包围体与更新 | Scene Extension | planned | 引擎内部使用 BufferGeometry，但没有稳定可信扩展上下文 | `EX-M4-MESH`、资源释放与非法缓冲诊断待建 |
| GEO-03 | Mesh/Line/LineSegments/Points/Sprite 的创建、查询与销毁 | Scene SDK + Scene Extension | partial | 内部用于模型、测量、标注和天气效果；没有公开对象构建器 | `CT-GEO-03`、`EX-M4-MESH` 待建 |
| GEO-04 | 裁剪、剖切、爆炸与对象状态效果 | Editor + Scene SDK | partial | 裁剪、爆炸、轮廓/辉光/XRay/扫描/热力等内部能力存在；公开命令不完整且双后端不齐 | `CT-GEO-04`、`EX-M4-EXPLODE`、`BR-*-GEO-04` 待建 |
| MAT-01 | 基础/PBR 材质参数、透明度、线框、双面、深度与混合 | Editor + Scene SDK | partial | 材质面板与 MeshStandard/Basic 等内部实现存在；SDK 没有 material 命令/查询 | `CT-MAT-01`、`EX-M4-MESH`、`BR-*-MAT-01` 待建 |
| MAT-02 | 纹理加载、色彩空间、UV/重复/偏移/旋转、过滤和资源释放 | Editor + Scene Extension | partial | 环境贴图、HDR/EXR/普通纹理加载存在；通用纹理资产和公开参数路径缺失 | `CT-MAT-02`、`EX-M4-MESH`、纹理释放基准待建 |
| MAT-03 | 自定义 shader/node material、uniform/node 输入与后端兼容声明 | Scene Extension | planned | 旧内部效果使用常规材质；没有可信自定义材质出口或 TSL 路径 | `EX-M4-FX`、双后端兼容诊断待建 |

### 3.4 灯光与阴影

官方边界：[Light](https://threejs.org/docs/pages/Light.html)、[DirectionalLight](https://threejs.org/docs/pages/DirectionalLight.html)、[WebGLRenderer shadow map](https://threejs.org/docs/pages/WebGLRenderer.html)。

| ID | 能力族 | 平台路径 | 当前状态 | 当前证据 | M4 退出证据 |
| --- | --- | --- | --- | --- | --- |
| LGT-01 | Ambient/Hemisphere/Directional/Point/Spot/RectArea 灯光创建与参数编辑 | Editor + Scene SDK | partial | `ViewerEngine` 已创建并编辑六类灯光及目标代理；SDK 无灯光接口 | `CT-LGT-01`、`BR-*-LGT-01` 待建 |
| LGT-02 | cast/receive shadow、阴影总开关、质量/类型、相机与 bias 调整 | Editor + Scene Extension | partial | 已有 cast/receive 和阴影开关；质量预算、阴影相机/bias 与双后端合同未齐 | `CT-LGT-02`、双后端黄金截图和性能预算待建 |
| LGT-03 | 环境照明、HDR/EXR、背景和曝光/色调映射 | Editor + Scene SDK | partial | 场景环境、HDR/EXR、全局照明已存在；公开能力与色彩管理门禁不完整 | `CT-LGT-03`、`BR-*-LGT-03` 待建 |

### 3.5 加载器与资源生命周期

官方边界：[Loader](https://threejs.org/docs/pages/Loader.html)、[LoadingManager](https://threejs.org/docs/pages/LoadingManager.html)、[GLTFLoader](https://threejs.org/docs/pages/GLTFLoader.html)。

| ID | 能力族 | 平台路径 | 当前状态 | 当前证据 | M4 退出证据 |
| --- | --- | --- | --- | --- | --- |
| LDR-01 | glTF/GLB 加载、Draco、动画/层级/材质保留与取消/错误恢复 | Editor + Scene SDK | partial | GLTFLoader + DRACOLoader、模型加载协调器和 GLB 导出存在；公开加载/卸载接口不足 | `CT-LDR-01`、`EX-M4-ANIM`、404/取消 `BR-*-LDR-01` 待建 |
| LDR-02 | FBX、DXF、IFC/Fragments 及转换后资产加载 | Editor + ConverterPlugin | partial | FBXLoader、DXF 解析、IFC/Fragments 已接入；能力一致性和插件边界未完成 | M5 转换黄金样本负责；M4 仅补通用加载合同 |
| LDR-03 | 自定义 Loader/解析器、LoadingManager、进度、缓存、凭据与 dispose | Scene Extension + ConverterPlugin | planned | 当前 Loader 固化在 `ViewerEngine`，无公开注册/卸载接口 | M5/M6 `EX-LOADER-PLUGIN` 与泄漏/错误隔离证据 |
| LDR-04 | Texture/Image/HDR/EXR 等资源统一寻址、内容去重与缺失诊断 | Editor + Scene SDK | partial | 环境纹理加载和模型 manifest 已有；统一资产句柄、引用计数/释放和诊断未齐 | `CT-LDR-04`、资源 404 恢复和内存基准待建 |

### 3.6 拾取、射线与空间查询

官方边界：[Raycaster](https://threejs.org/docs/pages/Raycaster.html)、[Ray](https://threejs.org/docs/pages/Ray.html)、[Box3](https://threejs.org/docs/pages/Box3.html)。

| ID | 能力族 | 平台路径 | 当前状态 | 当前证据 | M4 退出证据 |
| --- | --- | --- | --- | --- | --- |
| RAY-01 | 指针/XR 射线拾取，返回对象、点、法线、UV、face/instance 标识 | Scene SDK | partial | 内部 Raycaster 支撑选择、测量、放置与 XR；公开事件只暴露对象引用子集 | `CT-RAY-01`、`EX-M4-CAM-RAY`、`BR-*-RAY-01` 待建 |
| RAY-02 | ray/box/sphere/frustum 空间查询、过滤层与批量查询 | Scene SDK + Scene Extension | partial | 包围盒、碰撞/组件分析内部存在；没有稳定空间查询 API | `CT-RAY-02`、大场景查询性能基准待建 |
| RAY-03 | 自定义对象 raycast 与加速结构接入 | Scene Extension | planned | 已依赖 `three-mesh-bvh`，但无可信扩展注册面 | `EX-RAYCAST-PLUGIN`、隔离/卸载/性能证据待建 |

### 3.7 动画与时间

官方边界：[AnimationMixer](https://threejs.org/docs/pages/AnimationMixer.html)、[AnimationClip](https://threejs.org/docs/pages/AnimationClip.html)、[SkinnedMesh](https://threejs.org/docs/pages/SkinnedMesh.html)。

| ID | 能力族 | 平台路径 | 当前状态 | 当前证据 | M4 退出证据 |
| --- | --- | --- | --- | --- | --- |
| ANI-01 | glTF Clip 播放/暂停/停止/seek、循环、倍速与混合 | Editor + Scene SDK | partial | AnimationMixer、模型动画开关和 `animation.control` 协议存在；clip 选择/混合公开面不足 | `CT-ANI-01`、`EX-M4-ANIM`、`BR-*-ANI-01` 待建 |
| ANI-02 | 骨骼、Morph、关节层级和实时关节数据映射 | Scene SDK + Scene Extension | partial | Loader 可保留模型动画，但未见公开骨骼/Morph/关节控制接口 | `EX-M4-ROBOT` 与关节限位/插值合同待建 |
| ANI-03 | Tween、状态机、对象/相机多轨时间线、动画事件 | Editor + Scene SDK | partial | 已有相机/模型多轨时间线与关键帧采样；状态机、Tween、公开事件不完整 | `CT-ANI-03`、`EX-M4-EXPLODE`、`DX-ANI-03` 待建 |
| ANI-04 | fixed timestep、timeScale、暂停/恢复、记录/确定性回放和遥测插值 | Scene SDK | partial | `behaviorScheduler`、行为生命周期协议和主线程 Host 测试已存在；尚未完成编辑器/场景命令闭环与回放 | `CT-ANI-04`、`EX-M4-AGV`、`EX-M4-TAKT` 待建 |

### 3.8 实例化、渲染目标与后处理

官方边界：[InstancedMesh](https://threejs.org/docs/pages/InstancedMesh.html)、[BatchedMesh](https://threejs.org/docs/pages/BatchedMesh.html)、[RenderTarget](https://threejs.org/docs/pages/RenderTarget.html)、[WebGL 后处理手册](https://threejs.org/manual/en/how-to-use-post-processing.html)。

| ID | 能力族 | 平台路径 | 当前状态 | 当前证据 | M4 退出证据 |
| --- | --- | --- | --- | --- | --- |
| INS-01 | InstancedMesh 实例矩阵/颜色/拾取/包围体和动态更新 | Scene SDK + Scene Extension | planned | 仓库未见通用 InstancedMesh 公开能力；Fragments 的内部优化不能替代平台实例化 API | `CT-INS-01`、`EX-M4-INSTANCE`、10k/100k 实例基准待建 |
| INS-02 | BatchedMesh/合批、拆批、对象 ID 与选择语义保持 | Scene Extension | planned | 路线图有实例化/合批目标，尚无公共运行时证据 | `EX-M4-INSTANCE`、拾取/更新/释放基准待建 |
| RT-01 | 2D/Cube/Array/MRT 渲染目标、尺寸/附件/读取和释放 | Scene Extension | planned | 现有 EffectComposer 内部使用渲染目标，但没有公开生命周期和读取接口 | `CT-RT-01`、`EX-M4-FX`、显存泄漏基准待建 |
| FX-01 | WebGL EffectComposer 效果链、启停、排序和参数编辑 | Editor + Scene Extension | partial | WebGL 路径已有 SSAO/GTAO/Outline/Bloom/Bokeh/Afterimage/Film/Vignette/SMAA/FXAA；无可信自定义 pass，WebGPU 不承载此链 | `CT-FX-01`、`BR-WGL-FX-01`、后端限制诊断待建 |
| FX-02 | WebGPU RenderPipeline、Node 后处理、MRT 与等价降级 | Editor + Scene Extension | planned | 当前 WebGPU 后端没有 RenderPipeline/Node 效果链；官方明确其与 EffectComposer 不兼容 | `EX-M4-FX`、`BR-WGPU-FX-02`、`BR-WGL-FX-02` 待建 |

### 3.9 WebGPU、TSL、Compute 与数学工具

官方边界：[WebGPURenderer 手册](https://threejs.org/manual/en/webgpurenderer)、[WebGPU 后处理手册](https://threejs.org/manual/en/webgpu-postprocessing.html)、[TSL 手册](https://threejs.org/manual/en/threejs-shading-language.html)、[MathUtils](https://threejs.org/docs/pages/MathUtils.html)。官方说明 `WebGPURenderer` 可使用 WebGPU，并能回退到 WebGL 2；TSL 可面向 WGSL/GLSL；旧 `ShaderMaterial`、`onBeforeCompile` 与 `EffectComposer` 不能直接用于该渲染器。

| ID | 能力族 | 平台路径 | 当前状态 | 当前证据 | M4 退出证据 |
| --- | --- | --- | --- | --- | --- |
| GPU-01 | WebGPU 初始化、WebGL 2 回退、显式后端切换与场景状态保持 | Editor + Renderer Port | partial | 已有 WebGPURenderer 实验开关、能力探针、快照切换与回退提示；尚无 Auto 默认、设备丢失与实机矩阵证据 | `CT-GPU-01`、`BR-WGPU-GPU-01`、`BR-WGL-GPU-01` 待建 |
| GPU-02 | NodeMaterial/TSL 统一材质，后端能力声明与迁移诊断 | Scene Extension | planned | 未见 `three/tsl` 或 NodeMaterial 运行实现 | `EX-M4-FX`、WGSL/GLSL 双后端视觉证据待建 |
| GPU-03 | Compute、storage buffer、粒子/数据驱动计算与 CPU 等价回退 | Scene Extension | planned | 未见 Compute 管线；业务仿真仍应保持 CPU/宿主确定性 | M4 只做经过基准证明有收益的样例；`CI-GPU-03` 待建 |
| GPU-04 | 设备/驱动能力、限制、错误、设备丢失与重建诊断 | Editor + Renderer Port | partial | 已探测 secure context、WebGL2、GPU adapter 与纹理上限；device lost/重建和遥测未完成 | 实机原始探针、恢复 `BR-WGPU-GPU-04` 待建；若环境不支持才可转 `environment-blocked` |
| MTH-01 | Vector2/3/4、Euler、Quaternion、Matrix3/4、Color 和插值工具 | Scene SDK | partial | 引擎内部大量使用 Vector/Quaternion/Matrix/Color；SDK 仅暴露少量 tuple | `CT-MTH-01`、类型与序列化样例待建 |
| MTH-02 | Box/Sphere/Plane/Ray/Frustum/Triangle、相交与最近点 | Scene SDK + Scene Extension | partial | 测量、碰撞、包围盒与组件分析已有纯逻辑；公开数学/空间查询面缺失 | `CT-MTH-02`、`EX-M4-CAM-RAY` 待建 |
| MTH-03 | 曲线/路径、CurvePath、采样、弧长与朝向 | Scene SDK | partial | 时间线和 AGV 规划已提出路径能力，现有关键帧采样可复用；通用公开路径 API 未完成 | `CT-MTH-03`、`EX-M4-AGV` 待建 |

### 3.10 可信扩展上下文

官方边界是 Three.js `r184` 的公开模块和 addons，但平台只在管理员签名、显式权限和兼容协商后向 Scene Extension 暴露受控子集；普通行为脚本继续使用命令/查询/事件，不直接获得 Three.js、DOM、网络令牌或宿主对象。

| ID | 能力族 | 平台路径 | 当前状态 | 当前证据 | M4 退出证据 |
| --- | --- | --- | --- | --- | --- |
| EXT-01 | API 版本、capability/permission、host/renderer 与生命周期兼容协商 | Scene SDK | implemented | `protocol.ts`、`compatibility.ts` 及合同测试；纯数据协议不需要浏览器证据 | 升级时保持 `CT-EXT-01`；新增 capability 必须补反向兼容夹具 |
| EXT-02 | Worker 行为脚本、超时/限额、日志、命令校验和故障隔离 | Scene SDK | partial | 行为 scheduler/Host/worker、SceneCommand 深度校验与测试存在；编辑器运行/调试/发布闭环未完成 | 死循环、超量命令、非法命令、恢复 `BR-*-EXT-02` 待建 |
| EXT-03 | 签名 trusted-main-thread 扩展的版本化 Three 上下文 | Scene Extension | planned | manifest 可声明 `trusted-main-thread`，尚无签名加载器、受控上下文或卸载隔离实现 | M6 主责；M4 先冻结上下文接口并制作 `EX-M4-MESH/FX` 尖峰 |
| EXT-04 | 自定义编辑面板、命令、撤销、保存/发布和工作区上下文 | Scene Extension | planned | 已有编辑器面板，但无第三方面板 SDK | M6 主责；`DX-EXT-04` 与安装/禁用/崩溃隔离待建 |
| EXT-05 | 插件资源所有权、dispose、热重载、性能预算和错误定位 | Scene Extension | planned | 现有引擎有 dispose，但无插件级资源账本 | M6 主责；泄漏、禁用和升级 `CI-EXT-05` 待建 |

## 4. M4 代表性迁移与工业样例映射

每个样例目录应保存 `three-baseline.ts`、`dev-studio.ts`、`README.md`、固定输入、期望截图/数值和证据清单。`three-baseline.ts` 只能使用 `three@0.184.0` 的公开 API；`dev-studio.ts` 只能使用平台公开 API。两者按相同业务结果比较，而不是要求内部代码结构一致。

| 样例 ID | 任务 | 覆盖矩阵项 | M4 通过条件 | 当前 |
| --- | --- | --- | --- | --- |
| EX-M4-OBJ | 批量创建对象、建立两级父子关系、变换、搜索、选择、隐藏、撤销 | SCN-01/02/03、TRN-01/02 | 高频路径 ≤5 个主操作；代码路径宿主样板 ≤10 行；保存刷新后层级/ID 不变 | 待建 |
| EX-M4-CAM-RAY | 相机 flyTo/lookAt，世界屏幕转换，拾取对象/实例并显示点和法线 | CAM-01/02/05、RAY-01、MTH-01/02 | WebGL/WebGPU 返回同一稳定对象 ID；窄窗口仍可完成 | 待建 |
| EX-M4-MESH | 自定义 BufferGeometry、Mesh、PBR 材质和纹理，运行时修改并释放 | GEO-01/02/03、MAT-01/02、EXT-03/05 | 不改核心；类型/资源诊断齐全；重复启停无持续显存增长 | 待建 |
| EX-M4-ANIM | 导入带 Clip/骨骼/Morph 的 GLB，播放、混合、seek、暂停和恢复 | LDR-01、ANI-01/02 | 保存刷新和双后端的 clip/骨骼/Morph 结果一致 | 待建 |
| EX-M4-INSTANCE | 10k 可选实例按数据着色并局部更新 | INS-01/02、RAY-01、GPU-03 | 对象/实例 ID 稳定；帧时、内存和更新预算有固定基准 | 待建 |
| EX-M4-FX | 自定义 TSL 材质与 Node 后处理，并给出 WebGL 2 等价或明确降级 | MAT-03、RT-01、FX-01/02、GPU-01/02/04 | 两后端不静默丢效果；截图差异和限制说明进入 CI | 待建 |
| EX-M4-FPS | 第一/第三人称切换，在薄墙、门洞、台阶、斜坡和非法出生点移动 | CAM-03/04、RAY-02 | 跑步速度和低帧率压力下不穿模、不持续抖动、不陷地，可一键退出/恢复 | 待建 |
| EX-M4-EXPLODE | 设备层级拆解、可逆步骤、镜头/标注事件与时间线回放 | TRN-02/03、GEO-04、ANI-03/04 | 只用公开 API；步骤可编辑、撤销、暂停、seek 和确定性回放 | 待建 |
| EX-M4-AGV | AGV 路径运动、10 Hz 带时间戳遥测、插值/有限外推与断流状态 | MTH-03、ANI-04、SCN-03 | 实时/回放共享对象 ID 和时钟；乱序/抖动/断流结果可复现 | 待建 |
| EX-M4-ROBOT | 机器人关节层级、轴/限位、曲线与实时关节数据映射 | TRN-02/03、ANI-02/04 | 坐标系和限位可诊断；缺帧插值不跳变；不把 IK 写入核心 | 待建 |
| EX-M4-TAKT | 工位/载具状态机、事件队列、fixed timestep、倍速与记录回放 | ANI-03/04、SCN-02 | 不依赖渲染帧；同输入的状态/事件哈希跨双后端一致 | 待建 |

## 5. CI 与浏览器证据占位

以下文件/任务名是门禁约定，目前均为占位；创建并产出真实记录前不得视为已通过。

| 证据 ID | 计划位置/任务 | 内容 | 当前 |
| --- | --- | --- | --- |
| CI-CAP-01 | `pnpm gate:three-capabilities` | 校验 ID 唯一、状态合法、每个 `implemented` 项存在合同/样例证据且链接可达 | 待建 |
| CI-CAP-02 | `pnpm gate:public-api-imports` | 禁止样例导入 ViewerEngine、Three Adapter、React 私有状态或深层私有路径 | 待建 |
| CI-CAP-03 | `pnpm gate:three-example-size` | 比较基线与平台样例有效业务行、宿主样板行和主操作数 | 待建 |
| CI-CAP-04 | `pnpm gate:scene-sdk-contracts` | WebGL 2/WebGPU Scene SDK 命令、查询、事件和错误语义合同 | 待建 |
| CI-CAP-05 | `pnpm gate:render-visuals` | 黄金场景截图、像素/感知差异、效果降级清单和性能预算 | 待建 |
| BR-WGL-M4 | `artifacts/three-capabilities/r184/webgl2/` | Chrome/Edge 版本、GPU/驱动、截图、trace、控制台、任务结果 | 待采集 |
| BR-WGPU-M4 | `artifacts/three-capabilities/r184/webgpu/` | secure context、adapter/device limits、device lost/重建、截图、trace、控制台 | 待采集；若设备不支持，记录原始探针后逐项标 `environment-blocked` |
| DX-NOVICE-M4 | `artifacts/three-capabilities/r184/ux/novice.json` | 空账号完成对象→材质→事件→预览→撤销/保存的步骤、用时和失败点 | 待采集 |
| DX-EXPERT-M4 | `artifacts/three-capabilities/r184/ux/expert.json` | 与 ThingJS/Unity 任务基线对照的步骤、上下文切换、快捷键、批量操作和调试记录 | 待采集 |

浏览器证据最少记录：commit SHA、矩阵版本、Three.js 版本、浏览器完整版本、OS、GPU/驱动、renderer/backend、窗口与 DPR、测试入口、操作序列、控制台错误、截图/trace、成功判定和降级原因。仅有单元测试、页面按钮或人工口述不能替代它。

## 6. 状态升级与版本升级流程

### 6.1 功能状态升级

1. 建立或更新能力族行，绑定里程碑、负责人角色、公开平台路径和至少一个代表性样例；不允许无主项。
2. `planned → partial`：合入可运行子集，并附 CT/UT 证据；若只是内部尖峰，当前证据必须明确写“私有实现”。
3. `partial → implemented`：Editor/Scene SDK/Scene Extension 至少一条公开路径闭环；样例不改核心；类型、错误、撤销/释放、文档和 CI 通过；视觉/交互项同时提交 BR 与 DX 证据。
4. `* → environment-blocked`：先证明平台实现已通过非环境相关合同，再提交真实环境探针、用户诊断、降级路径和复测条件。环境恢复后必须重新执行浏览器门禁，不能永久豁免。
5. 任一合同、样例、浏览器或兼容性证据失效时，`implemented` 自动降为 `partial`；发布分支不得手工忽略。

### 6.2 Three.js 升级

1. 升级前复制本矩阵为新基线草案，阅读目标版本的官方 release 与 migration guide，并对 `r184..目标版本` 的公开 API/行为做能力族差异清单。
2. 先升级基线样例和双后端合同，受影响项重置为 `partial`；没有新版本证据时不得沿用旧 `implemented`。
3. 更新 Scene SDK/Extension capability、兼容诊断和迁移说明；业务脚本不得因 Renderer Adapter 私有改动而变化。
4. 重跑全部 CI、WebGL 2/WebGPU 浏览器矩阵与代表性迁移样例；全部通过后才修改锁定版本和矩阵头部。
5. 将旧矩阵、差异、截图和性能结果保留为可审计工件，避免“升级成功”只由编译通过判定。

## 7. 首版结论

当前仓库已经具备相当数量的 Three.js 内部能力，但公开 Scene SDK 仍主要是协议骨架；几何、材质、灯光、射线、层级、实例化、渲染目标、TSL/Compute 和可信扩展上下文均存在明显缺口。因此除纯协议兼容协商 `EXT-01` 外，本矩阵暂不把内部功能直接标成 `implemented`。M4 的首要工作不是继续堆叠私有 `ViewerEngine` 方法，而是用上述迁移样例把已有能力收敛到稳定、简单、可测试的公开路径。
