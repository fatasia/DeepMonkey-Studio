# Deep Engine 资产与 Unity 迁移兼容方案（2026-09-12）

## 1. 决策

资产兼容必须成为 Deep Engine 的一级架构，不应继续等同于“文件选择器允许某个扩展名”。正确路线是：

1. 所有源格式先进入隔离导入器，转换为版本化的 `Deep Asset IR`，再生成可发布的 `Deep Asset Package`。
2. Deep Native 运行时只读取 Deep Asset Package，不携带 Unity Player、Unity Editor、WebGL、WebView、浏览器 JavaScript/WASM 运行时、Three.js 或任意源格式 SDK。
3. Unity Editor 只能存在于用户配置的迁移机或构建农场。它负责理解 Unity 的 AssetDatabase、GUID、Scene、Prefab、Importer 和序列化对象，再导出中立 IR；不能嵌入正式客户端。
4. 冻结的旧 Web Studio 保持现有 Unity Web Build ZIP 和 25 个模型入口，不改变正式环境。迁移完成前，新旧产物使用独立路由、存储前缀、任务队列和发布门禁。
5. “兼容”按几何、层级、材质、纹理、动画、蒙皮、Morph、元数据、PMI、行为十个维度分别验收。缺少真实样本证据的维度必须明确标为不支持或部分支持。

这里必须直接指出一个冲突：Unity 导出的 WebGL 或 WebGPU Web Build 都不是通用模型包，而是需要浏览器执行 JavaScript、WASM 和 Unity Player 的应用。它们可以继续由旧 Web Studio 托管，但不能直接进入零 WebView 的 Deep Native 客户端。最终原生兼容的首选输入是 Unity 源工程、`.unitypackage` 或 UPM 包，经隔离 Unity Editor 转换为 Deep Asset Package。

## 2. 仓库当前真实能力

### 2.1 当前 Unity 能力是 Web Build 托管，不是 Unity 资产导入

本仓库的 Unity 路线具有以下可核对证据：

- `apps/api/src/unityResourceRoutes.ts` 只接受 ZIP，并明确提示“请选择 Unity WebGL ZIP”；解包前限制 512 MiB 压缩体积、2 GiB 解压体积和 12,000 个文件，阻断绝对路径、盘符与 `..` 越界路径。
- `apps/api/src/unityBuildInspection.ts` 要求 Loader、Framework、WASM 和 Data 四种 Web 运行文件，并记录压缩、载荷大小和调试符号。
- `apps/web/src/components/UnitySceneEmbed.tsx` 用 `<iframe>` 加载 `playerUrl`，以 `postMessage` 和 Bridge manifest 通信。
- `tools/unity/com.bim-studio.bridge/package.json` 的正式名称仍是“Deep Monkey Studio WebGL 桥接插件”，版本 `0.6.1`。
- 现有真机构建证据覆盖 Unity `2022.3.62f1` 和 `6000.0.52f1` WebGL；没有 `.unitypackage`、UPM、完整 Unity Project、`.unity` Scene、`.prefab`、AssetBundle 或 Addressables 的平台导入实现。

因此，当前能力只能命名为“Unity Web Build ZIP 托管与双向 Bridge”。它不能被写成“支持导入 Unity 包”。

### 2.2 Unity WebGL 与 WebGPU Build 的兼容边界

Unity 6.6 已把 WebGPU 升为正式支持的 Web 图形后端，但 WebGL 2 仍为默认。项目可以设置 WebGPU 优先、WebGL 2 回退，也可以删除 WebGL 2 生成 WebGPU-only 构建；WebGPU 还需要安全上下文。Unity 官方 Web Build 结构仍包含 `loader.js`、`framework.js`、`.wasm` 和 `.data`。

由此得到四个结论：

- 旧 Web Studio 的 ZIP 托管和 Bridge 协议在设计上与图形 API 无关，理论上可以托管 WebGL 2、WebGPU 优先或 WebGPU-only 构建。
- 当前检查器只证明通用 Web Build 文件齐全，不能证明实际启用了哪种图形 API。现有 manifest 需要新增 `graphicsApis`、`requiredFeatures`、`fallbackPolicy`、`secureContext`，并由运行实例回报 `SystemInfo.graphicsDeviceType` 后再确认。
- 当前仓库只有 2022.3/6000.0 WebGL 真机构建证据，尚无 Unity 6.6 WebGPU 构建、WebGPU-only 失败态、WebGL 回退、不同浏览器/适配器的实测证据。
- WebGPU Unity Build 仍依赖浏览器 JavaScript、WASM 和 Unity Player。图形 API 换成 WebGPU不会把它变成 Deep Native 资产。

如果产品必须保留已交付的 Unity Web Build，可提供独立的 `Unity Legacy Host` 制品或远程预览服务。它必须与 Deep Native core 分进程、分安装包、分权限和分发布指标，且不能计入原生引擎兼容率。

建议的 Web Build manifest 增量：

```json
{
  "graphicsApis": ["webgpu", "webgl2"],
  "requiredFeatures": ["secure-context"],
  "fallbackPolicy": "ordered",
  "secureContext": "required",
  "reportedGraphicsApi": "webgpu"
}
```

`graphicsApis` 必须来自 Unity 构建插件导出，`reportedGraphicsApi` 必须来自实际运行回报，两者不一致时阻断发布。

## 3. Unity 输入类型必须分开处理

| 输入 | 它实际包含什么 | Deep 迁移策略 | 可进入 Deep Native | 当前状态 |
| --- | --- | --- | --- | --- |
| `.unitypackage` | 从 Unity Project 导出的资产集合，导入后进入目标工程 `Assets` | 先做 tar/gzip 安全清单，再在一次性空工程中用匹配的 Unity Editor 无交互导入，运行 Deep Exporter | 只允许导出的 Deep Asset Package | 未实现 |
| UPM 本地包/`.tgz`/Git 包 | `package.json`、Runtime/Editor、程序集、依赖、Samples 等 | 锁定包版本和依赖，复制到一次性工程；禁网或只允许固定镜像；运行 Exporter | 只允许数据与已转换资产 | 未实现；现有 Bridge 自身是一个 UPM 源码包，不是平台导入口 |
| 完整 Unity Project | `Assets`、`Packages`、`ProjectSettings` 及 `.meta` GUID | 在只读源副本上创建临时工作副本，选择精确 Editor 版本，等待导入和编译完成后遍历 AssetDatabase | 是，保真潜力最高 | 未实现 |
| 单个 `.unity` Scene / `.prefab` | Unity 序列化对象及对外部资产的 GUID/fileID 引用 | 只有同时提供依赖工程或完整依赖包时才迁移；孤立文件只做识别和缺失引用报告 | 依赖闭包完整时可以 | 未实现 |
| AssetBundle | 面向特定 Unity 目标平台构建的运行时资产容器 | 默认仅识别 Unity 版本、目标平台、压缩、清单和哈希；要求源工程重导出。受控实验可由匹配 Unity Worker 加载支持对象并导出 | 原始 bundle 不可进入 | 未实现 |
| Addressables catalog + bundles | 地址、标签、Provider、依赖图和平台相关 AssetBundle | 识别 catalog/hash/profile/依赖；优先回到源工程按地址导出。没有源工程时只能走匹配 Unity Worker 的有限 Provider 路线 | 原始 catalog/bundle 不可进入 | 未实现 |
| Unity WebGL/WebGPU Build ZIP | Loader、Framework JS、WASM、Data、页面和 Unity Player | 旧 Web Studio 托管；迁移侧只记录和隔离，不能反向宣称得到源资产/Prefab/C# | 不可直接进入 | WebGL 已实现；WebGPU 待实测 |

`.unitypackage` 和 UPM 包可能携带 Editor 脚本、AssetPostprocessor、原生插件和自定义构建代码。仅解压缩并读取 YAML 不足以复现 Unity 的导入结果；直接打开不可信项目又会执行代码。每个 Unity 任务必须在一次性虚拟机或受限 Worker 中运行，使用独立账户、临时目录、默认断网、CPU/内存/磁盘/时限预算，任务结束销毁环境。

## 4. Deep Asset IR 与 Package

### 4.1 中立资产图

`DeepAssetManifest v1` 应把源资产、规范化 IR 和目标 GPU 派生产物分开：

```text
SourceArtifact (immutable, sha256)
  -> ImportRecipe (importer id/version/options/toolchain)
  -> DeepAssetIR (canonical graph)
  -> ValidationReport (dimension-by-dimension evidence)
  -> TargetDerivatives (meshlets, texture variants, BVH, animation pages)
  -> DeepAssetPackage (signed manifest + content-addressed blobs)
```

核心对象：

- `SceneIR`：场景、节点、父子关系、实例、可见性、Layer/Tag、变体和稳定源引用。
- `MeshIR`：顶点/索引、属性流、拓扑、submesh、bounds、LOD、meshlet 和碰撞代理。
- `MaterialIR`：标准 PBR 参数、纹理槽、采样器、alpha、double-sided、emissive，以及未迁移 shader 报告。
- `ImageIR`：源色彩空间、ICC/transfer function、alpha、normal/data 语义、mip 与目标压缩派生物。
- `SkeletonIR` / `AnimationIR`：骨骼、bind pose、蒙皮权重、clip、curve、event、root motion 和 morph target。
- `MetadataIR` / `PmiIR`：类型化属性、单位、分类、Element/GUID、装配关系、PMI 与来源路径。
- `PrefabIR`：Definition、Variant、Instance、override patch 和嵌套依赖，不把实例烘成互不相关的节点。
- `BehaviorDescriptor`：已知组件、序列化字段、事件绑定、依赖和迁移状态；不包含可直接执行的任意 C#。

IR 采用确定性序列化。同一源字节、工具链版本和导入选项必须得到同一根哈希；大二进制使用内容寻址 blob。Package 可以是目录或流式归档，但 manifest、blob 哈希、总大小、签名和许可证清单必须先验证再发布。

### 4.2 坐标、单位和颜色

- IR 固定右手坐标系、Y-up、米制；导入记录保留源 handedness/up-axis/unit，转换矩阵单独保存，禁止通过改顶点后丢失来源。
- 负尺度和镜像要修正 winding、切线 handedness 和法线；相机、光源、骨骼、碰撞和动画曲线使用同一变换规则。
- 颜色值统一进入线性工作空间；baseColor/emissive 纹理标记 sRGB，normal/metallic/roughness/AO 为线性数据。源 ICC/HDR transfer、曝光和超范围值必须保留或形成可见降级报告。
- 大世界坐标保留双精度源定位，并生成运行时局部原点/分区；不得在导入阶段直接截成单精度世界坐标。

### 4.3 GUID、引用和重导入

Unity 资产身份优先使用 `asset GUID + local fileID`。Scene/Prefab 内对象再加 GlobalObjectId 或等价局部路径，Deep ID 是这些来源身份的稳定命名空间映射。其他格式优先使用格式原生 ID；没有 ID 时使用规范化节点路径、几何签名和邻接上下文组合，绝不能仅用显示名称。

每次导入生成不可变 `SourceRevision -> RecipeRevision -> IRRevision -> PackageRevision` 版本链。重导入先计算差异：新增、删除、重命名、重父级、几何变化、材质变化、行为变化和引用断裂；然后把用户 override 按稳定 ID 重放到候选版本。发布采用“两阶段验证后原子切换”，取消、超时或校验失败只删除临时候选，不修改当前活动版本。

### 4.4 材质、Shader、动画和行为

- Unity Standard、URP Lit/Unlit 等建立版本化参数映射；纹理缩放/偏移、alpha、法线强度、emissive 和双面必须有真实图像对比。
- Shader Graph 和自定义 Shader 不可能通用自动翻译。先提取属性和纹理依赖；能映射的降为 Deep PBR，静态效果可选择烘焙，动态效果生成“需手工 WGSL/RenderGraph 迁移”报告。禁止静默替换成灰材质后标记成功。
- AnimationClip、Animator Controller、Avatar、Timeline 分开迁移。首批只承诺 Transform/骨骼/morph curve 和 clip；状态机、Blend Tree、AnimationEvent、Playable/Timeline track 必须按类型列出支持度。
- 内置组件通过明确映射表迁移，例如 Transform、MeshRenderer、SkinnedMeshRenderer、Camera、Light、Animator 和受控 Collider。未知 MonoBehaviour 保留类型名、程序集、序列化字段和对象引用，状态为 `manual-port-required`。
- 自定义 C# 不进入 Deep Native，也不能自动等价翻译。只允许经过审阅的行为迁移器把有限 API 转成 Deep 的类型化 Intent/行为图；网络、文件、反射、原生插件和线程代码必须显式阻断或人工重写。

## 5. 25 个现有扩展名的真实证据矩阵

盘点来源为 `packages/contracts/src/project.ts` 的 25 项 `supportedExtensions`、`apps/api/src/conversion.ts` 的实际 Provider，以及相应测试。路线含义：`direct` 为 Deep 已有直接 glTF/GLB 入口；`convert` 为仓库内转换；`provider` 为外部或专用 Provider；`subset` 为明确有限子集；`legacy` 为旧 Web/Three/Fragments 路线。

证据标记：`D2`=Deep Engine 有真实固定样本；`C2`=仓库转换器有真实固定样本；`W2`=旧 Web 运行时有真实固定样本；`1`=仅合成样本、结构检查或代码路径；`P`=依赖外部 Provider 合同；`0`=未找到该维度证据。它们都不等于生产样本矩阵。

| # | 扩展名 | 当前路线 → Deep 路线 | 几何 | 层级 | 材质 | 纹理 | 动画 | 蒙皮 | Morph | 元数据 | PMI | 行为 |
| ---: | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | `rvt` | provider → provider-convert | P | P | P | P | 0 | 0 | 0 | P | P | 0 |
| 2 | `ifc` | legacy → convert | W1 | W1 | W1 | 0 | 0 | 0 | 0 | W1 | 0 | 0 |
| 3 | `step` | convert → convert | C2 | C2 | C2 | 0 | 0 | 0 | 0 | C2 | 0 | 0 |
| 4 | `stp` | convert → convert | C2 | C2 | C2 | 0 | 0 | 0 | 0 | C2 | 0 | 0 |
| 5 | `iges` | convert → convert | C2 | C1 | 0 | 0 | 0 | 0 | 0 | C2 | 0 | 0 |
| 6 | `igs` | convert → convert | C2 | C1 | 0 | 0 | 0 | 0 | 0 | C2 | 0 | 0 |
| 7 | `dwg` | provider → provider-convert | P | P | P | P | 0 | 0 | 0 | P | 0 | 0 |
| 8 | `dxf` | legacy → convert | W1 | 0 | W1 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| 9 | `gltf` | direct → direct | D2 | D1 | D2 | D2 | 0 | 0 | 0 | D1 | 0 | 0 |
| 10 | `glb` | direct → direct | D2 | D1 | D2 | D2 | 0 | 0 | 0 | D1 | 0 | 0 |
| 11 | `fbx` | legacy → convert | W1 | W1 | W1 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| 12 | `obj` | legacy → convert | W1 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| 13 | `stl` | legacy → convert | W1 | 0 | W1 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| 14 | `3mf` | legacy → convert | W1 | W1 | W1 | W1 | 0 | 0 | 0 | W1 | 0 | 0 |
| 15 | `dae` | legacy → convert | W1 | W1 | W1 | W1 | W1 | W1 | W1 | 0 | 0 | 0 |
| 16 | `3ds` | legacy → convert | W1 | W1 | W1 | W1 | 0 | 0 | 0 | 0 | 0 | 0 |
| 17 | `x_t` | subset → subset/provider | C2 | C2 | 1 | 0 | 0 | 0 | 0 | 1 | 0 | 0 |
| 18 | `x_b` | provider → provider-convert | P | P | P | P | 0 | 0 | 0 | P | P | 0 |
| 19 | `jt` | subset → subset/provider | C2 | C1 | C1 | 0 | 0 | 0 | 0 | C1 | 0 | 0 |
| 20 | `usd` | legacy → convert/provider | W2 | W2 | W2 | W2 | W2 | W2 | 0 | W1 | 0 | 0 |
| 21 | `usda` | legacy → convert/provider | W2 | W2 | W2 | W2 | W2 | W2 | 0 | W1 | 0 | 0 |
| 22 | `usdc` | legacy → convert/provider | W2 | W2 | W2 | W2 | W1 | W1 | 0 | W1 | 0 | 0 |
| 23 | `usdz` | legacy → convert/provider | W2 | W2 | W2 | W2 | W1 | W1 | 0 | W1 | 0 | 0 |
| 24 | `urdf` | provider → native importer | W1 | W1 | W1 | W1 | 0 | 0 | 0 | W1 | 0 | W1 |
| 25 | `zip` | provider → native importer | W1 | W1 | W1 | W1 | 0 | 0 | 0 | W1 | 0 | W1 |

矩阵中的 `3mf/dae/3ds/dxf` 多数 `W1` 只是旧加载器存在，专用测试甚至只覆盖 OBJ 和 ASCII STL；不能从 Three loader 的理论能力提升证据等级。`zip` 只表示完整 URDF 机器人依赖包，不是通用 ZIP，更不能与 Unity Web Build ZIP 共用格式语义。

当前最强证据包括：

- Deep glTF/GLB 固定样本已覆盖几何、实例、PBR 参数、baseColor/metallic-roughness/normal/AO/emissive 纹理与 alpha/double-sided 路线；尚未覆盖动画、蒙皮、morph 和完整层级资产图。
- STEP/IGES 转换测试验证了 GLB 几何、米制、层级/属性，STEP 另有面颜色；这不等于 PMI 或精确 B-Rep 被保留到运行时。
- X_T 只支持单体共轴旋转体子集，测试明确写出 NURBS、颜色、完整属性等限制。
- JT 真实 9.5 样本验证 44 mesh、64 instance、47,962 triangles；当前层级不应被误报为完整装配归属。
- OpenUSD 官方样本只在旧 Three USDLoader 路线验证几何、命名节点、材质、贴图和一条骨骼动画；它不是完整 USD Stage/composition，也尚未进入 Deep Native。
- URDF 路线有包路径、关节、资源、姿态和失败回滚测试；它不表示通用机器人动力学或任意 ZIP。

## 6. 隔离导入服务与事务

每个导入任务必须遵循：

1. **预检**：读取有限头部、MIME/magic、版本、压缩目录和声明依赖；扩展名只用于提示，不能决定解析器。
2. **配额**：限制输入/输出字节、文件数、路径深度、压缩比、节点/primitive/顶点/纹理像素/动画 key 数、单字符串长度、依赖深度、CPU、内存、GPU 和总时限。
3. **隔离**：导入器子进程无正式数据库凭据，默认断网，只能读本次只读输入并写临时候选目录；Unity 任务使用一次性 VM/Worker。
4. **转换**：Importer 输出 canonical IR、诊断、依赖闭包和来源映射，不可直接写正式 CAS。
5. **验证**：schema、引用闭包、数值有限性、bounds、拓扑、纹理预算、动画时间、材质槽、许可证和恶意归档检查。
6. **派生**：生成按平台/适配器分组的压缩纹理、meshlet、BVH 和流式页；原始 IR 不因派生物变化而改 ID。
7. **提交**：全部 blob 先按哈希去重写入候选区，manifest 验签后一次性切换活动版本。取消和失败清理候选区，不碰旧版本。

任务合同必须有 `taskId`、`sessionId`、source hash、importer/version、deadline、cancellation token、progress sequence、diagnostic code、candidate root hash 和 active revision。导入器退出码为 0 但丢少量资产，仍应根据 required fidelity gate 判失败，而不是“部分成功”默认发布。

## 7. 近期最小纵向切片

首个可运行切片应选“Unity Prefab + glTF/GLB 共用 Deep Asset IR”，因为它同时打通 Unity GUID、层级、材质、纹理、动画和重导入，而不会先陷入 AssetBundle 逆向或全格式铺开：

1. 建一个最小 Unity Exporter UPM，只在隔离 Unity Editor 中运行。
2. 输入一个完整 Prefab 依赖闭包：嵌套 Prefab、实例 override、两个 PBR 材质、baseColor/normal/MR/emissive 纹理、一个骨骼、一条 clip、一个 morph、一个未知 MonoBehaviour。
3. 导出 `DeepAssetManifest + SceneIR + MeshIR + MaterialIR + ImageIR + SkeletonIR + AnimationIR + PrefabIR + BehaviorDescriptor`。
4. 由现有 Deep glTF/RenderPacket 路线渲染候选几何，并把原始层级、Prefab 身份和行为报告保存在资产图中。
5. 修改源 Prefab 的名称、父级、材质和一个 override，执行重导入差异与用户 override 重放；注入取消、超时、缺纹理、缺脚本和坏引用，确认活动版本不变。

这个切片完成后再并行推进 FBX 动画/蒙皮、IFC 语义、STEP/JT 装配、OpenUSD composition 和 URDF。AssetBundle、Addressables 无源工程恢复、任意 C# 自动转换都不应成为首批承诺。

## 8. 真实 fixture 与发布矩阵

### 8.1 Unity fixtures

| 组 | 最小真实样本 | 必须断言 |
| --- | --- | --- |
| Unity Editor | 2022.3 LTS、6000.0 LTS、6000.6 | exact editor、导入/编译成功、Exporter 版本、确定性根哈希 |
| 包 | `.unitypackage`、UPM 文件夹、UPM `.tgz`、完整 Project | GUID/fileID、依赖闭包、缺依赖诊断、Editor 脚本隔离 |
| 场景 | Scene、普通 Prefab、nested Prefab、Variant、override | 层级、激活态、实例身份、变体与 override 差异 |
| 渲染 | Standard、URP Lit/Unlit、Shader Graph、不支持的自定义 Shader | 参数/纹理、sRGB/linear、alpha、双面、降级报告、图像阈值 |
| 动画 | Transform、SkinnedMesh、morph、Animator、Timeline | clip/key/bind pose、状态机支持度、事件/track 未支持项 |
| 行为 | 已知内置组件、数据型 MonoBehaviour、Editor 插件、原生 DLL | 字段/引用保留、未知类型报告、任意代码不进入运行时 |
| AssetBundle | Windows/macOS/Linux 各自 bundle、错平台、错版本、损坏 bundle | 平台识别、哈希/CRC、明确拒绝、无静默加载 |
| Addressables | local/remote catalog、hash、依赖 bundle、更新版本 | address/label/依赖图、版本变化、缺 bundle、只识别时不误报可用 |
| Web Build | 2022.3/6000.0 WebGL、6000.6 WebGPU→WebGL、WebGPU-only | Loader/Framework/WASM/Data、HTTPS、实际 API 回报、回退/拒绝、Bridge |

### 8.2 25 格式 fixtures

每个格式至少需要：最小合法、真实复杂、损坏、超预算、缺外部依赖、坐标/单位边界、重导入变化七类样本。带动画的格式再加 skeleton/morph；CAD/BIM 再加装配、实例、属性、PMI；纹理格式再加 sRGB/linear/HDR/alpha/normal。每个样本记录来源、许可证、SHA-256、解析器版本、预期计数、bounds、截图/像素 hash 与已知丢失项。

## 9. 竞品 90% 与发布门禁

“格式多”不能计入接近 Unity/UE/Godot 的 90% 目标；要按加权资产工作流验收：

- 核心交换格式 30%：glTF/GLB、FBX、OBJ、STL、OpenUSD。
- 工业/BIM 25%：IFC、STEP/IGES、JT/X_T/X_B、DWG/DXF、RVT。
- Unity 迁移 20%：Project/package、Scene/Prefab/Variant、材质、动画、行为报告、重导入。
- 资产工程 15%：CAS、依赖图、增量构建、流式、LOD/meshlet/BVH、压缩纹理、取消/回滚。
- 质量与安全 10%：真实 fixture、跨平台、像素/结构/性能阈值、恶意包、确定性和可追溯许可证。

发布门禁：核心格式 required 维度全部达到真实 fixture level 2；每个 P0 格式至少三份不同来源生产脱敏样本；跨 Windows DX12、macOS Metal、Linux Vulkan 读取同一 Deep Asset Package；重导入稳定 ID ≥99.99%；失败/取消旧版本保留 100%；正式 native 依赖树和制品扫描中 Unity/WebView/WebGL/Three/browser runtime 为 0；性能预算单列解析峰值内存、派生耗时、首屏流式字节和 GPU 常驻字节。

在这些门禁达成前，只能说“具备某格式的导入路线或固定样本子集”，不能说“全面兼容 Unity 包和 25 种模型格式”。

## 10. 可重复盘点

新增的只读盘点脚本直接从仓库合同、Provider 和 Unity 实现生成证据，不依赖网络，也不修改正式环境：

```powershell
node packages/deep-engine/scripts/collectAssetCompatibilityInventory.mjs
node --test packages/deep-engine/scripts/collectAssetCompatibilityInventory.test.mjs
```

当前锁定结果为 25 个扩展名，25/25 均能映射到能力目录和 ConversionQueue；Unity 为 Web Build ZIP + iframe，`.unitypackage` 和 AssetBundle 导入均为 false。脚本同时输出七个权威源文件的字节数与 SHA-256，后续入口或 Provider 变化会使测试和审计显式变化。

## 11. 官方依据

- [Unity 6.0：导入本地 `.unitypackage`](https://docs.unity3d.com/6000.0/Documentation/Manual/AssetPackagesImport.html)
- [Unity 6.0：创建自定义 UPM 包与包结构](https://docs.unity3d.com/6000.0/Documentation/Manual/CustomPackages.html)
- [Unity 6.0：Editor batchmode 与 `-executeMethod`](https://docs.unity3d.com/cn/6000.0/Manual/EditorCommandLineArguments.html)
- [Unity 6.0：AssetBundle 为目标平台相关产物](https://docs.unity3d.com/6000.0/Documentation/Manual/assetbundles-platforms.html)
- [Unity Addressables 2.2：catalog、依赖、AssetBundle 与逐平台内容构建](https://docs.unity3d.com/Packages/com.unity.addressables@2.2/manual/AddressableAssetsOverview.html)
- [Unity 6.6：WebGPU 正式支持、WebGL 2 默认与 fallback/WebGPU-only](https://discussions.unity.com/t/webgpu-out-of-experimental-in-unity-6-6/1734694)
- [Unity：Web Build 的 Loader、Framework、WASM 与 Data 文件](https://docs.unity3d.com/cn/current/Manual/webgl-building.html)
- [Unity 6.0：模型格式和导入设置](https://docs.unity3d.com/cn/6000.0/Manual/ImportingModelFiles.html)

外部资料只用于确定边界和验收口径；本方案不复制第三方代码，也不向 Deep Native 运行时增加 Unity 或格式 SDK 依赖。
