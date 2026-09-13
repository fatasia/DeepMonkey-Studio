# Deep Shader：Unity 级 Shader 系统执行规格

日期：2026-09-12。状态：本轮待办持续推进；typed IR、Standard PBR lowering、DeepSL、Shader ABI v1、Package v2 与 Browser pipeline executor 已完成首批闭环。本文定义 Deep Engine 的 Shader 目标和兼容边界，不代表任意 Unity Shader 已可运行。

## 1. 决策

Deep Shader 采用“Unity 级生产模型 + 自研 typed graph/DSL + WGSL 唯一运行目标”：

- Shader 资产包含属性、Technique、Pass、渲染状态、能力要求、关键字和变体策略；材质只引用稳定的 Shader 接口，不拼接源码。
- Shader Graph、文本 DSL、标准材质模板和外部迁移器都先生成同一 typed Shader IR；IR 经验证、优化和反射后生成 WGSL。
- Browser Lab 与 Deep Native 共用 IR、WGSL、反射元数据、资源布局和 golden fixture；运行器分别创建 WebGPU/wgpu pipeline。
- 原生客户端不加载 Three、TSL、Unity Player、HLSL 编译器或浏览器 JS。离线工具可读取迁移输入，但输出必须是版本化 Deep Shader Package。
- WGSL escape hatch 仅作为受控模块进入：显式 stage、资源、输入输出、能力、预算和哈希；禁止运行时任意字符串注入。

Three TSL 的节点组合、分析与多后端生成值得参考；Deep 不需要 WebGL 输出，因此不继承双后端分支和 JS 运行时。Unity 的 ShaderLab、Shader Graph、Pass、材质属性、关键字与构建期裁剪是能力对标分母；Deep 自主定义格式和编译器，不复制 Unity 运行时。

## 2. 资产与编译链

```text
Deep Shader Graph ─┐
DeepSL text DSL ───┼─> typed Shader IR ─> validate ─> optimize/strip ─> WGSL modules
PBR/templates ─────┤          │                                  ├─> reflection/layout
Unity/Three importer┘          └─> source map + diagnostics       └─> pipeline cache package
```

编译输出必须包含：IR schema/version、编译器版本、目标 profile、Pass、入口点、bind-group layout、vertex/varying layout、override/keyword 集、WGSL、诊断/source map、源与依赖 SHA-256、确定性 cache key。相同输入和 profile 必须生成字节一致的输出。

固定绑定域：

| Group | 所有权 | 典型内容 |
|---:|---|---|
| 0 | frame/view | 相机、时间、曝光、全局光照、cluster/阴影索引 |
| 1 | material | 材质常量、纹理、采样器、材质资源表 |
| 2 | object/instance | transform、normal matrix、object id、skin/morph offset |
| 3 | pass/extension | pass 输入、storage、compute 或受控插件资源 |

布局由反射结果生成，TS/Rust executor 不各自猜测。动态 uniform、storage buffer、texture/sampler 数量和每阶段可见性都受 profile 与预算限制。

## 3. Pass 与渲染状态

首批图形 Pass：`forward-opaque`、`forward-transparent`、`depth-only`、`shadow-caster`、`object-id`；随后加入 `gbuffer`、`motion-vectors`、`meta/bake`、`fullscreen-post`、`decal` 和 compute。一个材质未提供所需 Pass 时必须走明确的模板生成或报告缺口，不能拿颜色 Pass 冒充 shadow/depth 行为。

每个 Pass 显式声明 topology、front face、cull、depth compare/write、stencil、blend、color write mask、sample count、attachment formats、vertex/fragment/compute stage 和 capability requirements。渲染图决定何时执行 Pass；Shader 不能私自提交 command encoder、创建 surface 或越过资源生命周期。

## 4. Typed IR 与轻量代码能力

内部 typed graph/IR 覆盖常量/属性、向量矩阵、算术、swizzle、比较与 select、纹理/采样器、UV/顶点属性、坐标空间变换、normal/TBN、PBR surface 输出和 vertex offset。它服务编译、验证和迁移，不建设复杂通用 Shader Graph 产品。

图验证必须拒绝类型不匹配、非法 stage、循环、未连接必需端口、重复 symbol/location/binding、越权资源、未声明 capability、非有限常量、动态递归和超预算图。编译器对常量折叠、死节点、公共子表达式、varying packing 和 stage/feature specialization 生成可审计报告。

DeepSL 是 IR 的文本前端，不直接等同 WGSL/HLSL。编辑器提供 Standard/Unlit 模板、Inspector、DeepSL/WGSL、预览、编译错误和必要的 pipeline 诊断；保存时只更新成功编译的候选，运行中的旧 Shader 在失败时继续可用。

### 4.1 Unity 能力、Three 级简洁度

编辑器采用渐进式创作层级，复杂能力不能强迫每个作者理解 Pass 和绑定布局：

1. 常用材质只选择 `Standard Surface` / `Unlit` 等模板并修改 Inspector 属性，使用成本接近 Three 的 `MeshStandardMaterial`。
2. 视觉作者使用受约束的 Surface 参数与少量节点表达式，复杂 Pass 由模板生成；不提供无限画布、通用 subgraph 市场或完整 Graph IDE。
3. 高级作者使用 DeepSL 和受控代码模块，显式声明 stage、资源、能力与预算；专家面板按需显示 Technique、Pass、变体和生成 WGSL。

编辑器保存完整资产和调试信息，发布器只打包实际材质/质量档位使用的 IR、Pass、变体、反射与 WGSL。编辑工具、编译器和未使用模板不进入 native 运行包。轻量门禁同时检查最小材质 API 的样板代码、冷/热编译耗时、变体数量、运行依赖、发布包字节数和首帧 pipeline 峰值。

## 5. 变体与缓存

关键字分为：材质静态 feature、项目/质量静态 feature、运行时动态 branch。互斥状态使用一个 keyword set 表达，禁止把每个布尔量独立做笛卡尔积。

构建器从实际材质、质量 profile、设备能力和 Pass 使用记录生成 allowlist；先执行约束求解和裁剪，再生成变体。每个 Shader、Pass、项目和发布包都有硬预算，超出即构建失败并输出贡献最大的 keyword 集，不能悄悄编译全部组合，也不能在缺失时选择“最接近”的错误变体。

cache key 至少包含：规范化 IR、依赖、compiler/schema version、entry/pass、静态 keywords、bind/vertex layout、render state、attachment/sample profile、设备 capability tier。内存 LRU、磁盘 CAS 与发布预热包共用同一标识；驱动私有 pipeline cache 只能作为目标设备加速层，不能替代可复现 WGSL 包。

## 6. Three 高频迁移边界

Three 标准/物理材质由迁移桥投影到 Deep PBR/Unlit 模板，不修改作者对象；项目已使用的少量 TSL 只有在语义可证明时才转 IR。ShaderMaterial、任意 GLSL、`onBeforeCompile` 和 renderer 私有 hook 不做逐项翻译，统一输出结构化 `unsupported` 并保留旧 Three 后端。Unity Shader/Shader Graph 迁移已删除出当前路线。

## 7. Unity 对标验收矩阵

“支持 Shader”至少同时通过以下八类，不能用一张材质截图代替：

| 领域 | 首个可交付门禁 | Unity 级目标门禁 |
|---|---|---|
| 创作 | typed IR/DeepSL、模板、属性、预览、错误定位 | 复制粘贴、撤销、热重载和低样板工作流；不含复杂 Graph IDE |
| Pass/管线 | forward/depth/shadow/object-id 行为一致 | gbuffer/motion/decal/post/compute 与自定义管线扩展 |
| 材质模型 | glTF PBR、normal/AO/emissive/alpha/double-sided | coat、anisotropy、transmission、SSS、hair/cloth/volume 按矩阵晋级 |
| 语言/节点 | 首批强类型节点和确定性 WGSL | 足够覆盖项目语料，扩展 API 稳定且可调试 |
| 变体 | 实际使用裁剪、硬预算、确定性 cache key | 多质量/平台预热、增量构建、无运行时卡顿峰值 |
| 调试 | WGSL compile info 回溯原节点/源码 | frame/pass/resource/variant/profiling 一体诊断 |
| 兼容 | Three 标准/物理材质真实样本报告 | 项目高频语料通过，未知私有 hook 有结构化 unsupported report |
| 性能/稳定 | 冷编译、热缓存、pipeline 创建、帧时和内存可测 | 同质量 P95/P99、构建大小、设备丢失和回滚达到冻结门槛 |

## 8. 批次顺序

1. `SHADER-00`：typed asset/Pass/graph IR、严格验证、确定性 hash、预算和 WGSL 最小编译链。
2. `SHADER-01`：把现有 PBR WGSL 纳入模板与反射布局，Browser/Native 消费同一编译产物。
3. `SHADER-02`：forward/depth/shadow/object-id 多 Pass、alpha/double-sided 和材质属性块。
4. `SHADER-03`：变体约束/裁剪、磁盘 CAS、异步预热、失败保留旧 pipeline、设备恢复。
5. `SHADER-04`：模板/Inspector/DeepSL 轻量编辑、预览、source map、必要 Profiler 与热重载。
6. `SHADER-05`：Three 标准/物理材质及项目已使用 TSL 的有限迁移器，冻结高频真实语料。
7. `SHADER-06`：compute、粒子、后处理、自定义 render feature 与高级材质模型。
8. `SHADER-07`：Browser WebGPU 与 Windows 原生 NVIDIA/AMD/Intel GPU 的画质、性能、编译、缓存与故障矩阵。

## 9. 当前迁移语料

首轮静态扫描覆盖 2,239 个 `apps/packages` 文件，记录 38 条 shader 相关证据：10 次 `onBeforeCompile`、10 个 TSL 导入符号、6 个嵌入 GLSL/HLSL 源码、4 个 vertex/fragment source 属性、3 个 program cache hook、4 个 depth/distance material 和 1 个 ShaderMaterial 构造器。逐行证据、语料 hash、缺失来源和迁移解释见 [当前源码 Shader 清单](deep-engine-shader-source-inventory-2026-09-12.md)与[原始 JSON](deep-engine-shader-source-inventory-2026-09-12.json)。

该数字只冻结静态迁移分母；持久化项目脚本、运行时拼接、公开资产与 Unity shader 资产仍须另行采集。

### 9.1 已落地的首批合同

`packages/deep-engine/src/shader` 已实现版本化 Shader→Technique→Pass 资产、typed property、固定四组绑定、attribute/varying、显式 render state、强类型表达式图、目标能力检查、确定性 WGSL、属性布局、逐节点 source map、SHA-256 pipeline cache key 与受预算的 keyword 变体裁剪。当前 Pass 种类为 `forward`、`depth`、`shadow`、`picking`；表达式已覆盖 literal/property/attribute/varying、基础四则与 min/max/pow、dot/cross、select/clamp/mix、normalize/negate/saturate、scale、位置/方向变换、compose-vec4、swizzle 和 fragment texture-sample。Standard Surface Output 已真实 lowering 为 GGX/Smith/Schlick、方向光、PCF 阴影、diffuse/specular IBL、AO、emission、alpha 和线性 HDR；缺失 world position、绑定冲突或能力不足时失败关闭。编译器从当前 Pass 输出反向取可达节点，只保留当前 Pass 使用的 property scope 与资源；使用中的 scope 保留完整属性结构和偏移，避免 Pass 间 ABI 漂移。

`packages/deep-engine/src/shaderMigration` 已冻结 12 类 Unity/Three 输入、9 个迁移能力面和 6 种迁移策略。未知或未验证输入失败关闭；部分支持只能在调用方显式允许 graph translate、受限代码、烘焙或人工移植后继续。它是迁移决策合同，还不是 ShaderLab/HLSL/Shader Graph 转译器。

`packages/deep-engine/src/shaderPresets` 提供 `buildUnlitShader()` 与 `buildStandardSurfaceShader()`：默认仅一个 forward Pass、零 keyword、零额外变体；只有显式 switchable 才生成相应 keyword/变体。Standard preset 使用 canonical POSITION/NORMAL/实例 model/normal locations，生成 world position/normal 和真实 PBR Surface Output；baseColor texture、metallic、roughness、AO、emission 与 alpha 进入 lowering。Standard 辅助 depth/shadow/picking Pass 仍失败关闭；Unlit 保留简单路径。

`packages/deep-engine/src/shaderAuthoring` 已实现 Graph/DeepSL 文本文档、确定性 revision、有界 undo/redo、候选编译事务、last-known-good 和异步 stale 防覆盖。内置的受预算 DeepSL surface v1 支持 Standard/Unlit、baseColor、metallic、roughness、alpha、double-sided 与 baseColor texture 声明，带行列诊断及 WGSL→DeepSL source map；当前只发布单个 forward 候选，多 Pass 文本语法尚未开放。隔离 Lab 已提供真实编辑入口，候选依次经过 DeepSL、typed IR、WGSL 和当前 GPU 驱动校验，失败时继续显示最后正确版本；这不是正式 Studio 或原生 GUI 已完成。

`packages/deep-engine/src/shaderPackage` 已实现 `deep-shader-package` v2 / `webgpu-wgsl-pipeline-2`：内容寻址 WGSL、依赖与源码 hash、冻结 ABI、entry point、bind group、vertex stream、attachment、深度、混合、剔除、MSAA/resolve、显式 pass selector、预算和完整 cache key。TypeScript/Rust 共用 golden；v1 被显式拒绝。Browser `ShaderPackageExecutor` 与 Native executor 均在验证后创建真实 ShaderModule/布局/RenderPipeline，候选全部成功才原子提交 cache，device epoch/lost 会失效；resolve target 由 render pass 提供。

`packages/deep-engine/src/shaderAbi` 已冻结高级 PBR 路径的 `deep.pbr.mesh.v1`：Frame 208B、Material 160B、Instance 144B、40B geometry、16B tangent、forward/shadow bind group、HDR/depth/MSAA resolve，以及六类 forward/shadow pass variant；golden SHA-256 为 `cbfaa36e9f2f689684e4a9086a61f165873d2a3398b6a4633aa5b2bcb117f46c`。Native ABI-1 已对齐 geometry/tangent/instance/material/UV1，ABI-2 已对齐 Frame 208B、rgba16float、4×MSAA、resolve 与独立 ACES 输出，ABI-3 已实现 group 0 bindings 0–6、2048² depth32float 阴影、真实 light VP、3×3 comparison PCF、静态 `{scene, light}` 版本缓存和实际 IBL 资源。

最新测试数、构建身份和真实 GPU package probe 见 [Shader 编辑器验证记录](deep-engine-shader-editor-verification-2026-09-12.md)。生成 WGSL 经 Naga 30.0.1 解析与验证；Lab 在 NVIDIA WebGPU 上真实创建 4×MSAA forward、depth32float shadow pipeline 和 GPU culling compute。DeepSL Standard 的无纹理/非双面固定子集已由 adapter 转成 `deep.pbr.mesh.v1` 的 forward/shadow pass，并在 Browser 与 Native 实机执行；纹理、MASK、双面、正式 Graph/DeepSL UI、磁盘 CAS/热重载、compute、clustered lights 和高级材质仍未完成。

## 10. 参考依据

- [Unity Shader Graph](https://docs.unity3d.com/cn/6000.0/Manual/com.unity.shadergraph.html)
- [Unity ShaderLab Pass](https://docs.unity3d.com/cn/current/Manual/SL-SubShader-pass.html)
- [Unity shader variant preprocessing](https://docs.unity3d.com/cn/6000.0/ScriptReference/Build.IPreprocessShaders.OnProcessShader.html)
- [Unity shader variant stripping](https://docs.unity3d.com/ja/6000.0/Manual/shader-variant-stripping.html)
- [Three.js TSL](https://github.com/mrdoob/three.js/wiki/Three.js-Shading-Language)
- [Three.js ShaderMaterial](https://threejs.org/docs/pages/ShaderMaterial.html)

这些资料只作为能力和工作流参考。Deep Shader 的格式、IR、编译、缓存、运行时与测试均由本项目自主实现。
