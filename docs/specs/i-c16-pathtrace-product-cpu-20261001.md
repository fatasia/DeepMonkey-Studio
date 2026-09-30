# I-C16 / T10 离线路径追踪出图产品模式——CPU 侧第一片

估时表 I-C16（`docs/specs/remaining-tasks-estimates-20260930.md`：复用 MC/RT 参考，24–48h，低信心）。
本刀只做 CPU 侧可独立验证部分：产品模式状态机（累积/材质变更失效/取消/导出/收敛）、累积缓冲
记账、Radiance HDR 导出编码、参考积分器接线接口；GPU 积分核、实机对拍与 WASM 留主线程串行
（`interrupted-engine-tasks-20260930.md`："CPU 实现可并行，Cargo/WASM 与 GPU 测量由主线串行调度"）。

## 现状核查（六步，2026-10-01 工作树版本）

1. **全仓 grep**（`packages/*/src`、`apps/*/src`，含 `git status` 未跟踪）：
   `pathTracer|pathTrace|path.tracing|softwarePathTracer` 仅命中
   `apps/web/src/optimizer/lightmapBaker.ts:81` 的注释——该文件**显式声明
   "intentionally avoids offline path tracing"**（浏览器烘箱只做遮挡/直接光，非 PT）；
   其余命中全在 node_modules。`packages/deep-engine/src/rayTracing/` 有软件 BVH/RT 参考：
   `rayTrace.ts`（`buildTracedScene`/`traceClosest`/`traceOccluded`，栈式 closest-hit，
   WGSL/Native 双端对拍仲裁基准）、`bvhBuilder.ts`（`buildBvh`/`intersectTriangle`
   Möller–Trumbore）、`tlas.ts`（两级 `traceTlasClosest`）、`rayBackendTypes.ts`
   （`RayBlasDescriptor`）。`packages/deep-engine/src/lighting/` 有 MC 参考积分器：
   `probeReferenceIntegrator.ts`（`integrateProbeReference` 分层蒙特卡洛 + 半分 z 检验 +
   `normalizedProbeFieldRmse`）、`probeReferenceScene.ts`（房间参考场景 +
   `createReferenceRng` 确定性 RNG + `uniformSphereDirection`）、
   `probeInvalidationConvergence.ts`（预算收敛推演）。
   **完整路径追踪核（相机光线 + 递归弹射 + BSDF 采样 + 逐像素累积）不存在 → 真实缺口。**
2. **契约已读**：`textures/radianceHdr.ts` 的 `RadianceHdrImage`
   （linear-sRGB、top-left 行主序 `Float32Array`、RGB `vec3` stride）——导出格式的既有合同，
   但**只有解码 `decodeRadianceHdr`，没有编码**；`rayTracing/rayBackendTypes.ts` 的
   `RayBlasDescriptor`（BLAS 输入合同）；`webgpu/pbrFramePlanExecutor.ts` /
   `pbrFrameGraph`（实时帧计划，只读参照，本刀不接线）；contracts 无帧导出契约。
3. **消费方已查**：`traceClosest` 被 `rayTraceExecutor.ts`/`tlas.ts` 消费（软件 WGSL 后端
   与 native wgpu RT 的仲裁基准）；`integrateProbeReference` 被
   `probeMultibounceReference`/`probeReferenceRenderPacket` 消费（T02 验收分母）；
   GPU 证据走 `scripts/rayTraceGpuTest.mjs` 等脚本模式（GPU 刀挂点）。
   导出侧无 `.hdr` 编码消费方（新能力）。
4. **T10 报告与 C8 native RT**：T10 章节在 `deep-engine-core-capability-development-plan-2026-09-27.md`
   L204（复用 rayBackend/软件 BVH/射线参考；验收含"标准漫反射小场景路径积分误差随样本增加
   下降；**材质变更立即重置累积**"）；C8 系列是双后端着色与 native DFG，与本刀无文件冲突；
   native `packages/deep-engine-native/src/**` 由 I-C23 并行占用，本刀零接触。
5. **规格**：估时表 I-C16 行、`deep-engine-gap-vs-unity-ue-2026-09-27.md`
   （T10 只交付静帧路径追踪，电影队列/编码/分布式排除）、09-30 双 handoff；
   **无 i-c16 既有规格，无 I-C16 相关未跟踪文件**。
6. **依赖**：不加运行依赖；vitest 已有；新文件受 `scripts/sourceSizeGate.mjs`
   300 行门（301 行阻塞）；AbortSignal 校验模式参照 `assetBakeResidency.ts`
   （validate + `AbortError` 包装）；状态机世代事务与零泄漏测试模式参照
   `webgpu/dynamicIblResidency.test.ts`（I-C19）；显式 seed 模式参照 I-C17
   （seed 完整 u32、同 seed 逐值一致）。

### 已有（不重建）

BVH 构建/三角形相交（bvhBuilder）、栈式遍历（rayTrace.traceClosest/traceOccluded）、
两级 TLAS（tlas.ts）、探针场分层 MC 参考与归一化 RMSE（probeReferenceIntegrator）、
确定性参考场景与 RNG（probeReferenceScene）、预算收敛推演（probeInvalidationConvergence）、
Radiance HDR 解码（radianceHdr.decodeRadianceHdr）、AbortSignal 校验（assetBakeResidency）、
世代事务状态机与 dispose-spy 零泄漏测试（dynamicIblResidency）。

### 真实缺口

① 离线出图产品模式状态机（idle→accumulating→invalidated→reaccumulating→cancelled→exported）
及其每状态的资源/预算语义不存在；② 累积缓冲记账（样本数/在线方差/失效代际/字节预算）
不存在；③ 收敛判据（样本数 × 方差双门）不存在；④ Radiance HDR 只有解码没有编码，导出断链；
⑤ 完整软件 PT 核不存在——本刀只给最小接口与复用组件清单，**不重写核、不冒充已有 PT 能力**。

## 产品模式状态机设计

### 状态与触发矩阵

| 状态 | 进入条件 | 资源语义 | 预算语义 |
|---|---|---|---|
| `idle` | 构造后 | 无累积缓冲驻留（bytes=0） | 仅配置校验 |
| `accumulating` | `begin()` 通过字节预算 | 注入 lease（均值平面+方差平面）驻留，记账开启 | 驻留字节=估算值 ≤ 上限；批次样本数 ≤ 样本上限 |
| `invalidated` | `accumulating`/`reaccumulating` 上 `invalidate()` | **lease 保留复用**（重置不重分配），记账清零 | 同 accumulating |
| `reaccumulating` | `invalidated` 上 `begin()`（无新分配，复用 lease） | 同 accumulating，代际 +1 | 同 accumulating |
| `cancelled` | abort 信号命中或显式 `cancel()` | **lease 立即释放**（dispose 恰一次），gen/samples 冻结为只读收据 | bytes 归零 |
| `exported` | `export()`（仅收敛后可入） | lease 交还调用方语义（均值已被导出方消费），bytes 归零 | 收据含最终样本数/方差/代际 |

转移规则（其余一切转移非法，fail-closed 拒绝）：

- `idle --begin(accept)--> accumulating`；`idle --begin(rejected)--> idle`（无状态变更）。
- `accumulating --advanceBatch--> accumulating`（收敛可为 true 但停留在 accumulating，出图才进 exported）。
- `accumulating|reaccumulating --invalidate--> invalidated`（代际 +1、样本/方差清零、lease 复用）。
- `invalidated --begin--> reaccumulating`（复用，不重分配）。
- `accumulating|reaccumulating|invalidated --abort/cancel--> cancelled`。
- `accumulating|reaccumulating --export(收敛)--> exported`；未收敛 export 拒绝且状态不变。
- `exported --begin--> accumulating`（重新分配新 lease；出图后改场景的合法路径）。
- `cancelled` 为终态：任何推进/失效/导出拒绝，只能 `dispose()`。
- `dispose()` 任何状态合法；未释放的 lease 释放，已释放/无 lease 幂等；dispose 后一切调用抛错。

### 失效语义（材质变更）

触发依据 = 调用方给出的**场景修订身份三元组**（`sceneRevision`/`materialHash`/`cameraHash`，
与 I-C19 iblIdentity 同型）：任一变化即 `material-revision` 失效；另有 `explicit-request`。
**粒度 = 全量**：累积是逐像素在线统计，部分失效没有合法来源（与 I-C19 全量失效裁定同理由）。
失效动作：generation+1、样本数清零、在线方差清零、converged=false；**lease 不释放**
（重置不重分配，避免大分辨率下的反复分配抖动）。相机变化与材质变化同码处理：
对路径追踪出图，相机与材质任一变化都要求重置累积，无"仅相机便宜"特权。

### 取消语义（AbortSignal 贯穿）

- `begin` 时传入的 signal 合法性按 `assetBakeResidency` 口径校验（非对象/缺 `aborted` 抛
  TypeError）；已 aborted 的 signal 允许传入但 `begin` 立即按取消处理（fail-closed）。
- `advanceBatch` 每批先查 `signal.aborted`：命中则本批**丢弃**（不入记账）、释放 lease、
  转入 `cancelled`，返回 `status: "cancelled"`（不抛异常——状态推进是结果不是错误）。
- 显式 `cancel()` 无需 signal，同语义。`cancelled` 保留只读收据
  （已完成代际/样本数），不保留可推进状态。

### 预算拒绝负例（fail-closed）

- 字节预算：`estimateAccumulationBytes(config) > maxAccumulationBytes` → `begin` 返回
  `rejected("budget")`，**零状态变更**（同 I-C19 "连单个 mip 都超限时拒绝并保持旧世代"）。
- 样本上限：单批累计超过 `maxSamples` → 该批拒绝（不入记账），状态不变。
- 记账污染防护：`advanceBatch` 可带可选 `generation`，与会话代际不符 → RangeError（防跨代统计）。

## 收敛判据（样本数与方差双门）

与 `probeReferenceIntegrator` 同口径：逐样本标量 X = 通道均值（RGB 平均，线性域）。

- **样本门**：`sampleCount ≥ minSamples`（中心极限成立的最小档，默认 64）。
- **方差门**：全图聚合标准误 `se = sqrt(overallVariance / sampleCount)`（在线合并：
  sum/sumSq → `var = sumSq/n − mean²`，数值安全下限钳 0），相对参照亮度
  `relativeSe = se / max(mean, brightnessFloor)`（floor 防全黑图除零，默认 1/65535），
  `relativeSe ≤ varianceThreshold`（默认 0.01 = 1%）。
- **双门 AND**：任一不满足即未收敛。只报样本数不报方差（或反之）都不得声称收敛。
- 方差是**全图聚合口径**（单标量），逐像素自适应门（火焰高光 vs 暗角分区阈值）是 GPU 刀
  扩展点，本刀不冒充。

## 导出管线（仓内已有格式）

- **格式 = Radiance HDR（`.hdr`，RGBE）**：与仓内 `decodeRadianceHdr` 同族互逆。
  本刀新增 `encodeRadianceHdr`：modern RLE（`2,2` 魔数 + 四通道独立 RLE），
  RGBE 量化 `value = mantissa · 2^(exp−136)` 与解码器 `writePixel` 严格互逆，
  roundtrip 相对误差 ≤ 1/128（mantissa 8-bit 半格 + ceil 进位补偿）。
- 输入合同：`RadianceHdrImage`（linear-sRGB、top-left、Float32Array）。
  **负值/非有限输入 fail-closed 拒绝**（Radiance RGBE 无负值表示；物理辐射非负）。
- **EXR 不在本刀**：无既有 OpenEXR 底座，自研 EXR（含压缩）超出 CPU 第一片边界；
  规格登记为 GPU 刀/后续切片的可选项（外部依赖准入需走工业格式硬门槛同等审计）。
- 导出动作 = `session.export()` 产出收据（尺寸/代际/样本数/方差/格式标签）+
  调用方对累积均值平面执行 `encodeRadianceHdr`；像素平面归调用方持有，
  会话只做记账与就绪仲裁（真实像素在 GPU 刀由 GPU 读回产生）。

## CPU 参考积分器接线（对拍期望生成器）

**裁定：仓内没有现成软件 PT 参考**（rayTrace 是命中参考、probeReferenceIntegrator 是
探针场参考，均无递归弹射/BSDF 采样）。按"不重写核"纪律，本刀交付**最小接口 + 复用组件
清单**，PT 核本体留下一片（CPU 参考核也要新建，但不属本刀状态机切片）：

```ts
/** 完整核待建；本刀只冻结接口形状。实现必须：确定性（同 seed 逐位同输出，
 *  I-C17 显式 seed 模式）、纯 CPU、fail-closed 校验。 */
export interface PathTraceReferenceKernel {
  /** 单像素单样本路径积分；x/y 像素坐标，sampleOrdinal 批内序号，seed 完整 u32。 */
  traceSample(x: number, y: number, sampleOrdinal: number, seed: number): readonly [number, number, number];
}
/** 复用组件（已存在，不重建）：buildTracedScene/traceClosest（命中）、
 *  createReferenceRng/uniformSphereDirection（确定性采样）、
 *  buildReferenceRoomScene（黄金场景）。新建件：相机射线生成、
 *  Lambert/GGX BSDF 采样、Russian roulette、逐像素累积归并。 */
```

GPU 刀的实机对拍 = GPU 积分核输出 vs 本接口实现输出，收敛门同参数双跑；
对拍前不得引用本刀收敛结果宣称画质正确。

## GPU 刀边界（留主线程）

本刀零 GPU 命令（不跑 `test:ray-trace-gpu` 等任何 GPU 脚本，不重建 WASM）。GPU 刀范围：
WGSL 路径积分核与累积纹理、设备能力探测与软件回退裁定（T10 验收"不支持设备明确使用
软件/光栅路径"）、逐像素方差门、GPU 读回 → `encodeRadianceHdr` 出图、实机对拍、
实机证据（`test-output/`）。`pbrRenderer.ts` 等被并行任务占用的文件届时按主线协调接线。

## 本刀交付与验证

- `src/rayTracing/pathTraceSessionTypes.ts`：类型、字节估算、收敛双门、身份三元组失效判定（纯函数，239 行）。
- `src/rayTracing/pathTraceSession.ts`：`PathTraceProductSession` 状态机（lease 注入 + dispose-spy 可测，239 行）。
- `src/rayTracing/pathTraceReferenceKernel.ts`：PT 核最小接口 + 复用组件声明（不实现核）。
- `src/textures/radianceHdrEncode.ts`：`encodeRadianceHdr`（modern RLE + width<8 flat，
  与仓内解码器分支合同互逆；RGBE 表示域边界 fail-closed）。
- `src/index.ts`：追加主入口导出（不改既有导出）。

### 实测结果（2026-10-01）

- 聚焦 vitest 3 文件 29 用例全绿（状态机矩阵 12、收敛门与纯函数 9、HDR roundtrip 8）。
- `vitest run src/rayTracing src/textures`：35 文件 319 用例全绿（既有 RT/HDR 参考无回归）。
- `tsc --noEmit` + `tsconfig.lab.json` + `tsconfig.examples.json` 全部通过。
- 全量 `vitest run src`：637/641 文件通过；4 个失败
  （`hlodProxyDrawBatch`、`cascadedShadowMathWgslChecksum`、`outputFamilyWgslChecksum`、
  `pbrEnvironmentIntensity`）全部归属并行任务在途改动（`runtimePackage/renderPacket*`
  链 + I-C23 layered-material 能力面 drift + WGSL 钉值，工作树有对应未跟踪规格/fixture
  为证），与本刀改动集（index.ts 追加导出 + 7 个新文件）零交集，未由本刀放宽或跳过。
- `sourceSizeGate`：本刀全部新文件 ≤239 行；现存 4 个 failures 全在
  `packages/deep-engine-native/src/**`（I-C23 并行占用域，本刀禁触）。
- **GPU 命令：本刀零 GPU 脚本执行**（未跑 `test:ray-trace-gpu` 等，未重建 WASM），
  实机命令留主线程。

### 诚实条款

- 完整软件 PT 核**未实现**（按"不重写核"纪律只冻结接口）；本刀收敛统计测试用合成
  样本流，未用真实路径积分样本。
- 导出收据仅仲裁"可导出"，真实像素平面归调用方；GPU 读回 → `encodeRadianceHdr`
  的端到端出图未验证（GPU 刀）。
- RGBE 共享指数导致暗分量相对精度无下界（绝对精度由像素最大分量决定）——
  这是格式固有属性，测试口径按绝对误差登记，不冒充逐通道 1% 相对精度。
- 状态机是单线程编排记账层；多会话并发互斥、跨 worker 调度不在本刀。

