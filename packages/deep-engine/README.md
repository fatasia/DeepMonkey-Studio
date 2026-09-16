# Deep Engine

Deep Engine 是 Deep Monkey Studio 的 WebGPU 引擎与跨端合同包。除 headless 合同、调度基础与独立 WebGPU 材质验证管线外，`./runtime-package` 与 Deep2d 显示列表合同已接入 Studio Web 端的发布编译链（`apps/web/src/delivery`），并与 Native 播放器共享同一套资源身份与校验；既有 Three.js 渲染器路径保持不变。

`bakeRenderPacket` 提供可选的确定性资产预处理：生成 Meshlet 与一次性展开的间接索引，汇总材质变体和纹理清单，并返回内容缓存键。产物是不可变且可丢弃的，不会改变正式 Three.js 资源流；静态光照只声明 `probe-hybrid` 策略，动态灯光、编辑和剖切仍走实时路径。

当前边界：

- Three 兼容 profile 只描述本项目实际使用面，不做全量 API 承诺。
- 场景状态保持引擎中立，稳定对象 ID 与快照优先于渲染实现细节。
- 渲染图和帧调度器提供确定性校验、拓扑排序与失败隔离；有效图同时产出临时资源生命周期和物理槽计划。只有显式提供包含格式、尺寸、采样数与 usage 的完整 `aliasKey` 才允许跨资源复用，外部资源永不进入临时槽。
- 后端切换协调器保留同一共享状态，在宿主帧边界交接，支持取消、超时与迟到资源清理。
- 默认入口保持 headless；`./webgpu` 是独立显式入口，创建实例时才使用浏览器 GPU/Canvas。
- WebGPU 夹具自主实现共享网格/材质/实例、GGX 材质、阴影、HDR、轻量 Bloom、Vignette、ACES 曲线近似与单次 sRGB 输出；支持仿射矩阵、非均匀缩放和镜像绕序。
- 默认 GPU 生成摄影棚 cubemap、GGX 预过滤 mip、漫反射辐照度和 DFG 查找表；每次设备初始化只预计算一次。静态阴影复用，相机/曝光变化不重绘阴影。
- `./gltf` 是无 IO 的 glTF/GLB 解码入口，支持 POSITION/NORMAL/TEXCOORD_0、无索引或无符号索引、交错布局、材质 factor、`emissiveFactor`、`alphaMode` OPAQUE/MASK/BLEND、活动场景层级，以及嵌入 PNG/JPEG 的 baseColor、metallic-roughness、normal、occlusion、emissive 纹理、sampler 和 `KHR_texture_transform`。图片像素解码通过注入的 `GltfImageDecoder` 完成；法线贴图缺少 `TANGENT` 时从几何与 UV 生成切线。独立入口已覆盖节点动画、骨骼蒙皮、morph 及二者融合，并能投影到 GPU 运行时；KTX2/Basis 转码与 BC/ETC2/ASTC 上传位于 `./textures` 和 `./webgpu`。稀疏 accessor、glTF mesh 压缩扩展、外部动画 buffer 与外部 HDRI 仍会结构化拒绝。
- WebGPU 材质真实采样 baseColor/emissive 的 sRGB 数据、metallic-roughness 的线性 B/G 通道、normal 的线性 RGB 和 occlusion 的线性 R 通道。AO `strength` 只衰减漫反射/镜面 IBL 等间接光；统一的有界材质布局用 uniform 启用位跳过未使用纹理采样，normal 有独立切线顶点变体。发光在线性 HDR 光照后、雾化与显示 tone mapping 前叠加。MASK 在颜色和阴影 pass 使用相同的 `baseColorFactor.a × baseColorTexture.a < alphaCutoff` 判定。BLEND 使用 straight-alpha source-over，进入独立透明 pass，关闭深度写入并按相机深度稳定地逐实例从后向前排序；当前透明材质不投射阴影。`doubleSided` 关闭颜色与阴影背面剔除，并在背面光照前翻转法线；镜像双面实例仍可合并批次。
- 根入口提供版本化 `Deep2dDisplayList` 及严格校验，作为 ECharts/zrender、React 视图适配器与未来 native `wgpu` 2D painter 之间的批量 path/text/image/clip/hit-region 合同。该合同已被 Native 侧 `Deep2dRuntimeContent`/ChartIR 呈现管线消费：原生窗口中的图表、图例、tooltip 与 hit-region 都由它驱动（见 `packages/deep-engine-native/src/chart/` 与真实窗口冒烟证据）。
- 诊断采样可启用 timestamp-query，异步最多 3 组读回；忙时跳过计时，不阻塞渲染，并报告实际样本数。设备不支持时降级为仅 CPU/帧间隔数据。
- 隔离 Lab 的 `/benchmark` 提供 Deep WebGPU 与 Three.js 0.185.1 WebGPU 的 1,024/10,000 实例成对交错基准。它冻结 960×540、DPR 1、相机、同一几何缓冲、实例矩阵、PBR 参数、主光和无纹理输入，双方均使用真实 WebGPU 与实例化路径；GPU 时间戳逐帧串行读取，Three 返回值已由其 r185 `WebGPUTimestampQueryPool` 换算为毫秒，不再二次换算。当前双方的 IBL、阴影、后处理、ACES 曲线和资源统计口径仍不完全等价，证据合同会标记 `degraded` 并强制 `outcome=withheld`；画面相似度未过门槛或出现 page/device/GPU 错误则标记 `invalid`，不得引用 CPU/GPU 数字宣称胜负。
- 流式资源使用一个 geometry/texture 统一显存预算。`PacketResidencyDomain.loadSet()` 可在同一帧原子合并多个 packet；`createSceneChunkResidency` 让大场景按 visible/prefetch chunk 提交，跨 chunk 共享相同资源并卸载离开 desired set 的 chunk。请求规划器保留每个可见 LOD 批次的可绘制最粗层，只按可见性追加细节层和纹理 mip。`createPbrResidencyStream` 把 latest-wins 请求、GPU 校验和 `PbrRenderer.render()` 帧边界发布串成一条有所有权约束的路径。supersede/abort 会停止未开始的上传并销毁迟到候选；等价请求只有全部 waiter 取消才中止共享执行。结果中的 `cancellationBoundary` 区分取消发生在 resident 驱逐前还是之后：已提交的 GPU queue 命令仍会安全完成，驱逐后的取消只提交空成功集以保持 CPU/GPU 驻留状态一致。
- 每个实例独占设备和受管资源，无内部全局 RAF。宿主驱动按需绘制；首帧等待 GPU 完成，普通帧不强制同步。
- `./shader-authoring` 提供编辑器中立的 Graph/DeepSL 会话、确定性 revision、有界撤销重做、异步 stale 丢弃和 last-known-good。内置 DeepSL surface v1 可把 Standard/Unlit 的基础属性编译为 typed IR 与 WGSL；Standard 已执行 GGX/Smith/Schlick、直接光、PCF/CSM 阴影、IBL、AO、emission 和线性 HDR 输出。编辑会话仍以单个 forward 候选为基本编译单元；Standard Package adapter 会进一步生成完整 forward/shadow 变体。Graph UI 与通用多 Pass 文本语法继续施工。
- `./shader-abi` 冻结高级 PBR 路径的 `deep.pbr.mesh.v1`：Frame 208B、Material 160B、Instance 144B、40B geometry、16B tangent，以及 forward/shadow 的绑定、附件、MSAA resolve、alpha/raster/pass variant。
- `./shader-package` 提供 `deep-shader-package` v2，完整记录 WGSL、entry point、ABI、顶点流、bind group、附件、深度、混合、剔除与 MSAA/resolve，并由 TypeScript 与 Rust 共用 golden 和 cache key。Browser 与 Rust executor 都能在验证后原子创建 ShaderModule、布局和 RenderPipeline，失败或 device lost 不污染缓存；Browser executor 已接入按设备 epoch 隔离的全局有界 pass LRU，同一整包并发创建去重，所有缺失 pass 成功后才同步发布。WebGPU pipeline/module/layout 没有 `destroy()`，LRU 淘汰只丢缓存引用。bind group、几何、attachment 与 draw 仍由 renderer 按 executable layout 提供。
- `./shader-cache` 提供与 namespace、compiler、target、ABI 和 package/pass cache key 严格绑定的内容 LRU 与设备 pipeline LRU。内容层可注入异步原子 `ShaderPackageCacheStore`，支持损坏/过期驱逐、同 key 并发去重和 allowlist 预热；显式调用 `createIndexedDbShaderPackageCacheStore` 后可启用浏览器持久化 CAS，其完整事务同时负责 schema/content hash 复核、有界字节与条目预算、确定性 LRU、损坏项清除和取消。设备 epoch 变化只清理 GPU 本地对象；WebGPU module、pipeline 和 device handle 永不进入 IndexedDB。native `ShaderDiskCache` 已完成 Windows 原子 no-clobber 发布、实例锁、generation 回退、CRC/hash 复核、预算/LRU 与取消边界；仍需接入原生 package executor 的实际预热调用。
- DeepSL Standard 的固定 ABI adapter 已覆盖 OPAQUE/MASK/BLEND、单面/双面、五个 glTF core 纹理槽、UV0/UV1 变换、TBN normal、AO 与 emissive。它为 `deep.pbr.mesh.v1` 生成有界 forward/shadow 变体，也可选择 `deep.pbr.mesh.v2` 的四级 CSM 布局；BLEND 明确不投影。材质默认值和纹理参数分别进入 144B instance 与 160B material ABI，发布前反向核对 Frame208、绑定、顶点流、入口点、attachment 和完整 pipeline layout。统一 `adaptDeepSlToShaderPackage` 入口也能生成可执行 Unlit Package：支持 baseColor/emissive factor 与纹理、UV0/UV1 变换、OPAQUE/MASK/BLEND 和镜像/双面变体；MASK 的颜色与阴影共用 alpha 判定，BLEND 不生成 shadow。不适用于 Unlit 的 metallic/roughness/MR/normal/AO 声明会返回机器可读错误，不会静默忽略。

实现路线见 [复审执行方案](../../docs/specs/deep-engine-execution-plan-2026-09-12.md)。
渲染图是 headless 合同，不是 GPU executor；切换测试不代表真实 canvas 无黑帧。
`DeepSceneState` 用于状态合同验证，尚未用于产品作者对象图，快照也不应作为逐帧数据通道。
取消信号仅属于一次后端准备/交接请求，后端激活后不得把它用作持续运行的生命周期信号。

通过以下命令验证：

```bash
pnpm --filter @bim-studio/deep-engine typecheck
pnpm --filter @bim-studio/deep-engine test
pnpm --filter @bim-studio/deep-engine build
pnpm --filter @bim-studio/deep-engine inventory:three docs/specs/deep-engine-three-source-inventory-2026-09-12.json
pnpm --filter @bim-studio/deep-engine lab:build
pnpm --filter @bim-studio/deep-engine lab:isolation
pnpm --filter @bim-studio/deep-engine lab:serve
pnpm --filter @bim-studio/deep-engine benchmark:residency-planner
```

源码清单区分类型/值引用并保留来源 hash；`unresolved` 需要进一步采集语料，全部符号初始为 `unverified`。
TypeScript 扫描器属于开发工具，不从运行时入口导出。

通用资源入口：

```ts
import { decodeGlb, decodeTexturedGlb } from "@bim-studio/deep-engine/gltf";
import { PbrRenderer } from "@bim-studio/deep-engine/webgpu";

const packet = decodeGlb(modelBytes, { resourcePrefix: "model-1" });
const texturedPacket = await decodeTexturedGlb(texturedModelBytes, imageDecoder, {
  resourcePrefix: "model-2",
  signal,
});
const renderer = await PbrRenderer.create(canvas, navigator.gpu, signal);
await renderer.setPacketValidated(packet, signal);
await renderer.validateFrame(view);
// 帧循环由宿主掌握；作者矩阵改变后只投影实例，几何继续驻留。
renderer.updateInstances({ materials: packet.materials, instances: nextInstances });
renderer.render(view);
```

编辑器可直接创建 DeepSL 会话；编译失败时运行态继续保留最后一次正确 WGSL：

```ts
import {
  createShaderAuthoringSession,
  DEEP_SL_SURFACE_EXAMPLE,
} from "@bim-studio/deep-engine/shader-authoring";

const authoring = createShaderAuthoringSession({
  schemaVersion: 1,
  id: "material.main",
  mode: "text",
  language: "deepsl",
  source: DEEP_SL_SURFACE_EXAMPLE,
}, {
  capabilities: {
    features: [],
    limits: {
      maxBindGroups: 4,
      maxBindingsPerBindGroup: 16,
      maxInterStageShaderVariables: 16,
    },
  },
});

const candidate = await authoring.session?.compileCandidate();
const runnable = candidate?.view.lastKnownGood?.artifact;
```

完整包用于加载或几何变化，包含严格扫描、复制和版本检查；实例增量入口不扫描几何。异步 `setPacketValidated` 在 GPU 错误作用域成功后发布，取消或失败保留旧包。低层同步 `setPacket` 和动画更新不能作为异步 GPU 载入成功门禁。完整空包/销毁释放几何；实例增量空包保留几何，便于隐藏后再显示。

实验 GLB 来源与许可固定在 `lab/assets/sources.json`；Cesium/Khronos 的 Box、BoxInterleaved、BoxTextured 与 AlphaBlendModeTest 按 CC BY 4.0 提供，NormalTangentTest 与 TextureEncodingTest 按 CC0 1.0 提供，原始文件均未修改。真实样本分别覆盖交错几何、嵌入纹理、运行时/作者切线、normal、metallic-roughness、R 通道 AO、双面光照、颜色空间、缺失法线生成以及 OPAQUE/MASK/BLEND。Lab 的 MaterialModes/UV 集仍是从未修改 BoxTextured 解码结果构造的自有运行时合同样本。固定样本不代表任意工业模型兼容。

实验页地址 `http://127.0.0.1:5291`，公平基准地址为 `http://127.0.0.1:5291/benchmark`；两者仅提供静态夹具和本地验证记录写入，无产品 API/数据库/项目访问。CPU 提交耗时不是 GPU 时间；固定球体场景不能证明超过其他引擎。记录保存到 `test-output/deep-engine/`，带加载构建的 SHA-256；构建变化后必须刷新再验证。
