# Studio GPU 动画整合实施方案

本方案供 Three 作者适配、GPU 变形和渲染集成三条工程线实施。目标是在同一作者时间线上，让骨骼与 morph 动画经 GPU 变形进入 Deep 主画面、阴影、运动历史和空间系统。

状态：**本轮待办**。本文定义拟实施合同，不代表现有 Studio 已支持 SkinnedMesh/morph。

## 交付要求

- 作者 Viewer 是唯一时间与姿态来源；Deep 不创建第二个播放器，不再次调用 mixer.update。
- 每顶点 morph/skin 在 GPU 执行，不以 CPU 变形并逐帧上传顶点替代。
- 不同 pose 可共享静态 geometry，但不得共享可写变形结果；主 pass、透明 pass 和阴影消费同一姿态。
- 最终 P0 包含提交一致的 motion、保守动态 bounds，以及现有 Hi-Z、LOD/Meshlet、驻留能力的合流。
- 跳过变形对象的静态剔除只允许用于首轮正确性联调，不能作为最终验收结果。

## 现有入口与差异

下列路径均相对仓库根目录，事实依据为 2026-09-14 本地代码。

| 入口 | 当前行为及需修改处 |
| --- | --- |
| `apps/web/src/viewer/viewerEngineRuntime.ts` | `animate` 中推进 mixers，随后通知 presentation；继续作为唯一动画时钟 |
| `apps/web/src/viewer/viewerFramePresentation.ts` | 外部 Deep 激活后可绕过作者 renderer，但保留作者矩阵更新与帧通知 |
| `apps/web/src/viewer/StudioDeepWebGpuBridge.ts` | `renderDeepFrame`、`updateAuthorMatrices` 和提交后补绘是姿态采集与消费入口；settle 不推进作者动画 |
| `packages/deep-engine/src/threeBridge/objects.ts` | `inspectObject` 目前拒绝 SkinnedMesh 和 morphTargetInfluences |
| `packages/deep-engine/src/threeBridge/geometries.ts` | `geometryView` 拒绝 morphAttributes；`normalMappedGeometry` 会压紧顶点，必须暴露并复用重映射 |
| `packages/deep-engine/src/threeBridge/ThreeProjectionBridge.ts` | 负责静态源、实例投影和 acknowledge；需区分静态变形源与动态姿态版本 |
| `packages/deep-engine/src/webgpu/gpuMorphSkinning.ts` | 已有 `GpuMorphSkinner.setSource/updateDynamics/encode`，输出 48-byte position/normal/tangent |
| `packages/deep-engine/src/webgpu/gpuMorphDeformation.ts` | morph-only 能力入口；与 fused 输出合同核对后复用 |
| `packages/deep-engine/src/webgpu/gpuSkinningTypes.ts`、`gpuSkinningPacking.ts` | `weightMode` 默认 `normalize`，已支持 `preserve`，尚未接入作者路径；零总权重仍拒绝。默认生成 inverse-transpose normal palette，不可直接宣称等价于 Three |
| `packages/deep-engine/src/webgpu/meshBuffers.ts` | 当前主顶点为 40-byte position3/normal3/uv4；不能直接绑定 48-byte fused 或 32-byte skin-only 输出 |
| `packages/deep-engine/src/webgpu/pbrShader.ts` | previous clip 使用上一实例矩阵与当前顶点，尚不包含上一变形姿态 |
| `packages/deep-engine/src/webgpu/pipelines.ts` | normal-map 与 previous transform 已占 location 0–15；不能再增加第 17 个顶点 attribute |
| `packages/deep-engine/src/webgpu/packetDraw.ts` | 普通、间接、LOD 绘制汇合点，需按 pose 选择当前/上一 GPU 输出 |
| `packages/deep-engine/src/webgpu/packetCulling.ts` | bounds 来自静态 geometry，不能用于最终动态变形剔除 |
| `packages/deep-engine/src/webgpu/packetBuffers.ts` | `encodeCulling/encodeLod/commitFrame` 与驻留发布边界需接入变形状态 |

Three 语义对照使用本地 `packages/deep-engine/node_modules/three/src/` 下的 `objects/SkinnedMesh.js`、`renderers/webgl/WebGLObjects.js`、`renderers/shaders/ShaderChunk/skinning_vertex.glsl.js` 和 `skinnormal_vertex.glsl.js`，版本为 0.185.1。

特别注意：骨骼 `boneMatrices` 通常由作者 renderer 的 `skeleton.update()` 刷新。Deep 绕过作者渲染后，不能直接把该缓存当作最新姿态。适配器应读取已更新的 bones.matrixWorld 与 boneInverses，构造自有 palette；不调用 skeleton.update，也不修改作者资源。

## 首片冻结接口

首片先新增 `packages/deep-engine/src/deformation/types.ts`，由工程线 A 持有。以下为拟实施接口，名称与字段在首片测试中冻结后供 B/C 引用。

```ts
interface DeformationSource {
  readonly id: string;
  readonly revision: number;
  readonly geometry: string;
  readonly kind: "morph" | "skin" | "morph-skin";
  readonly morph?: GpuMorphSource;
  readonly skinning?: SkinningSource;
  readonly semantics: "three-r185";
}

interface DeformationPose {
  readonly id: string;
  readonly source: string;
  readonly revision: number;
  readonly morphWeights?: GpuMorphWeights;
  readonly palette?: SkinningPalette;
}

interface DeformationSnapshot {
  readonly sources: readonly DeformationSource[];
  readonly poses: readonly DeformationPose[];
}
```

`GpuMorphSource/GpuMorphWeights` 复用 `webgpu/gpuMorphTypes.ts`，`SkinningSource/SkinningPalette` 复用 `webgpu/gpuSkinningTypes.ts`。`kind` 必须与字段存在性匹配；validator 拒绝悬空引用、重复 ID、错配顶点数量和非法版本。

拟扩展 `RenderPacket.deformation?: DeformationSnapshot`、`RenderInstance.pose?: string`。动态更新合同同步包含 poses；不能只更新实例矩阵却丢弃姿态变化。静态源不变时复用自有快照，不逐帧复制 positions/deltas。

约束：

- 版本单调；同版本不同内容拒绝。数组必须是自有数据，不引用作者可变 buffer。
- `pose.id` 是作者对象/姿态身份，不是 geometry ID。不同骨架或不同 morph weights 必须具有独立输出。
- 静态资源可以共享；批次 key 必须包含 pose ID。只有相同 pose 的实例可以合批。
- group 裁切、索引重映射、切线生成后的顶点序必须与 skin joints/weights、morph delta 完全一致。
- 保持既有 36-float instance ABI。新 JSON 元数据必须往返保留；未支持该合同的 Native 显式拒绝，不静默退化成静态模型。本切片不修改 Native。

### GPU 消费接口

工程线 B 新增 `webgpu/packetDeformationResources.ts`，对 C 提供：

```ts
prepare(snapshot: DeformationSnapshot, signal?: AbortSignal): Promise<void>;
updatePoses(poses: readonly DeformationPose[]): void;
encode(encoder: GPUCommandEncoder): void;
drawStreams(poseId: string): {
  current: GPUBuffer;
  previous: GPUBuffer;
  vertexCount: number;
  stride: 48;
};
commitFrame(): void;
cancelFrame(): void;
dispose(): void;
```

以上方法名为接线合同；实现需区分后台候选与 active 状态。`prepare` 成功不等于发布。首次输出 previous=current；只有成功 submit 才提交当前姿态为下一帧历史。取消、设备丢失、隐藏未提交、编码异常不能推进 previous。

所有变体统一 48-byte GPU 消费布局，可通过专用 shader 输出完成；不能用 CPU 逐顶点转换皮肤输出。前后姿态缓冲采取提交一致的双缓冲或 GPU copy 策略，不能让下一次 compute 覆盖仍代表上一提交帧的内容。

## 三条并行工程线

### A：作者快照、包合同与静态映射

所有权：新增 `deformation/types.ts` 与 validator、`threeBridge/deformation.ts`；修改 `objects.ts`、`geometries.ts`、`ThreeProjectionBridge.ts`、RenderPacket 类型/验证/JSON 往返及相应测试。

首片可立即实施：先冻结上述数据接口，采集一个 morph-only Mesh 和一个 SkinnedMesh 的自有快照，保证暂停、拖动时间线和两对象共享 geometry 的身份正确。此片不解除整个 Studio 的 unsupported，等 B/C 接通再开放支持。

Three palette 位置矩阵为 `bindMatrixInverse × bone.matrixWorld × boneInverse × bindMatrix`。Attached/Detached 模式及作者世界变换分别测试。Three 法线使用加权线性变换，不是默认 inverse-transpose；显式 normal palette 可复用已有输入槽，但 tangent 中间正交化等差异仍需 B 核对。

Three shader 不自动归一化 skinWeight；现 packing 默认 `weightMode: "normalize"`，本轮已新增 `"preserve"` 保留原始权重，但尚未接入作者路径。正式作者适配须显式选择 `preserve`；两种模式当前均拒绝总权重小于 `1e-8` 的顶点，这一输入边界仍须纳入作者兼容测试，不能宣称任意 Three 权重均已支持。

并行中的 `authorSkinPose.ts` 首片负责当前作者骨骼 palette 的自有快照；其完成不代表 GPU 变形、绘制、motion 或动态 bounds 已接通，其余仍按下述分片推进。

### B：GPU 变形、资源与动态 bounds

所有权：`packetDeformationResources.ts`、既有 morph/skin/fused compute 与 packing 的作者语义变体、动态 bounds 模块和 GPU 测试。不编辑 C 的渲染 shader/pipeline。

依赖 A 的类型即可并行开发。复用现有 GPU 算法与资源分配，不创建第二套动画播放器。静态源按 revision 上传，热帧只更新 weights/palette；后台候选失败保留 active，所有部分分配必须回收。

最终提供保守 bounds：可选择 GPU reduction，或静态 joint/morph 包络结合当帧 palette 的保守计算。后者允许 CPU 做 O(joints/targets) 包围体运算，但不允许 CPU 逐顶点变形。必须覆盖负 morph 权重、非均匀缩放、镜像和多个姿态，不能仅依赖 bind-pose sphere。

### C：绘制、历史、空间合流与 Studio 开放

所有权：`packetDraw.ts`、`meshBuffers.ts`、`pipelines.ts`、`pbrShader.ts`、`packetBuffers.ts` 的调度接线，以及 Studio Bridge 消费入口。`pbrRenderer.ts` 保持调度职责，不继续堆资源管理。

变形 pipeline 通过现 group 1 扩展 current/previous storage vertex pulling，以 vertex_index 读取；静态 UV 流保持不变，不突破四 bind-group 与十六 vertex-attribute 的最低设备能力。plain/textured、透明、solid/MASK shadow 分别创建对应布局/入口，既有静态路径保持原布局。

顺序为 GPU deformation → 动态 bounds/可见性准备 → shadow/main/OIT → temporal/post → submit → deformation/instance/history commit。Previous clip 同时使用上一对象变换与上一变形位置。

LOD 每一级必须具备匹配变形源或明确映射，驻留切换须原子发布 geometry+deformation，不能把粗级顶点直接套细级 palette 属性索引。Meshlet bounds 必须覆盖当前变形；Hi-Z 的历史 revision 随姿态与动态 bounds 更新。

## 合流与验收

三线合流前以接口夹具并行测试；解除 Studio 拒绝必须在真实 GPU 路径连通后进行。

| 门禁 | 必须通过的断言 |
| --- | --- |
| 同一作者状态 | 播放、暂停、seek、脚本改权重只推进原时间线一次；Deep↔WebGL 切换不跳时间、不改作者数组 |
| GPU 路径 | morph-only、skin-only、morph→skin 均有真实 compute 和主画面证据；禁止 CPU 顶点上传替代 |
| 共享资源 | 同 geometry 两个 pose 同帧结果不同；交换/销毁其中一个不污染另一对象 |
| 材质与阴影 | textured/plain、normal map、OPAQUE/MASK/BLEND、cast/receive/fog/unlit 原语义保留；主画面与阴影同姿态 |
| Motion | 物体矩阵不变但骨骼或 morph 改变时 motion 非零；暂停后稳定；失败或取消帧不提交历史 |
| Bounds | 顶点越出 bind-pose bounds 后仍可见且投影正确；不存在靠全局关闭剔除过最终验收 |
| 空间系统 | Hi-Z、LOD、Meshlet、resident/indirect 路径使用有效动态 bounds 和对应姿态；LOD 切换不串 pose、不出现一帧静态模型 |
| 生命周期 | source 更换、重入、取消、部分分配失败、设备丢失、恢复后资源计数回稳；无未处理 Promise |
| 性能 | 静态源不逐帧重传；同 pose 不重复 compute；报告骨数/顶点数/目标数、CPU 上传字节和 GPU 时间，不用 IAB 调度 FPS 代替 GPU 基准 |

验证顺序：合同/packing 单测 → Naga → GPU readback 数值对照 → 主 pass/阴影/motion 集成 → Studio 真实资产截图与切换 → 全量测试、双类型、构建、纯度和源码体量门禁。

CPU mirror 仅作为测试 oracle，不进入生产渲染。临时跳过变形对象 Hi-Z/LOD 可以用于定位，但最终报告必须保留为本轮待办，直到动态 bounds 与现有能力合流通过。
