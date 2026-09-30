# I-C19 动态 IBL 投影阴影——CPU 侧（更新/失效/资源预算）

估时表 I-C19（12–24h，低信心）。本刀完成 CPU 侧全部可独立验证部分：失效语义、
资源预算、回收时序的状态机与 CPU 参考预滤波生成器；GPU 实际帧对照留给主线程串行执行。

## 现状核查（六步，2026-09-30 工作树版本）

1. 全仓 grep（packages/*/src、apps/*/src、含未跟踪）：`dynamicIbl|iblUpdate|iblBudget|ibl.*invalidat`
   仅命中无关域（`localShadowCacheInvalidation.test.ts`=局部阴影、`deformationProjector.test.ts`=形变）。
   IBL 更新/失效/预算的 CPU 决策层**不存在**，真实缺口。
2. 契约已读：`runtimePackage/environmentTypes.ts` 的 `RuntimeIblMip`/`RuntimePrefilteredIbl`
   （specular 必须完整 mip 链、diffuse 恰 1 mip、LUT 方形、解码字节合计 ≤ `RUNTIME_IBL_MAX_BYTES`=64MB）；
   `webgpu/studioEnvironment.ts` 的 `StudioEnvironment`（dispose 所有权）；
   `webgpu/pbrEnvironmentState.ts` 的帧边界 staging/publish/rollback/supersede/epoch 事务已完整。
3. 消费方已读：`PbrRenderer.stageEnvironment → createPbrEnvironment`（pbrEnvironmentSource.ts，
   studio/prefiltered-ibl/radiance-hdr 三源）、`mainBindings.setEnvironment` 重绑、
   作者链 `StudioDeepWebGpuBridge`/`viewerEngineRig.setSceneEnvironment`/`SceneEnvironmentPanel`；
   探针侧 max 2 cube、owner 去重、无跨代缓存（I-C15 明确）。环境热替换生命周期已由
   `PbrEnvironmentState` 承担，本刀不重复、不接线 pbrRenderer（该文件被 C8/HDR 线占用）。
4. 测试与证据：`prefilteredEnvironment.test.ts`、`pbrEnvironmentState.test.ts`（dispose spy 零泄漏模式）、
   `reflectionProbeSpecularEnvironment.test.ts`（假 DeviceSession fixture）；I-C15 实机证据
   `test-output/i-series-0930/reflection-probes/evidence.json`。CPU 回归模式可复用。
5. 规格：`docs/specs/i-c15-production-box-reflection-20260930.md`（已关闭，主线统一提交 3aaeec5e）、
   `docs/specs/remaining-tasks-estimates-20260930.md` I-C19 行、09-30 双 handoff。无 i-c19 既有规格。
6. 依赖：不加运行依赖；复用 vitest、既有 fake session 模式；新文件遵守 sourceSizeGate 300 行门。

**已有（不重建）**：HDR IBL 导入上传（prefilteredEnvironment）、GPU panorama→prefilter
（hdrEnvironment + environmentShader，GGX 重要性采样/余弦积分/DFG 全在 GPU）、帧边界环境事务、
资源准入、探针 2-cube 预算、`validateRuntimePrefilteredIbl` fail-closed 校验、`visitIblBytes` 字节遍历。

**真实缺口**：① 失效语义（何时失效、幂等、LUT 免重传）无 CPU 判定层；
② active+pending 双份驻留的预算与降级决策缺失；③ 世代回收时序与零泄漏断言缺失；
④ CPU 参考预滤波（对拍期望生成器）缺失——现有 prefilter 是纯 GPU 计算，无从对拍。

## 失效语义设计

### 触发矩阵

| 触发源 | 判定依据 | 失效动作 |
|---|---|---|
| 初始装订（无 active） | `previous === undefined` | `initial`，全量上传 |
| 环境包替换 | id / revision / source.contentHash 任一变化 | `identity`，全量失效 + 新世代 staging |
| 同包重复提交 | identity 三元组全等且无 pending | `unchanged`，幂等拒绝（不建世代） |
| 作者改背景色/雾/分级/探针配置 | 不触达 `RuntimePrefilteredIbl` 载荷 | 不失效（环境包内非 IBL 字段从不触达 IBL 资源） |
| 作者换 HDR 源文件 | contentHash 变化 | 走"环境包替换"行，全量失效 |
| **光源大改**（direction/radiance/localLights/lightProfiles） | 不属于 IBL 载荷 | **显式非触发**：split-sum IBL 是视图无关、
  光源无关的辐射分离和（specular mips/diffuse irradiance/DFG 只依赖环境辐射与数学积分）；
  直射光变化由 CSM/直射路径独立消费。误失效只会浪费上传带宽，故裁定为"keep"并有测试锁定。 |

### 失效粒度：全量失效，分 mip 驻留

- **失效粒度 = 全量**。`RuntimePrefilteredIbl` 是原子单元（无部分 mip 生产者），部分 mip 失效
  没有合法来源；不存在"作者只改了 mip 5"这种输入。
- **驻留粒度 = 分 mip（预算降级）**。降级 = 链头（最大 = 最锐利端）截断重定基：保留链尾
  `keptMips` 个 mip，纹理基尺寸取 `mips[raw - kept].size`，采样端 roughness→level 钳制到
  `keptMips-1`。低频（diffuse/高 roughness）不受影响，锐利反射退化为保留链最锐层——
  字节收益最大（mip0 占全链 ~67%）、视觉损失可控。GPU 采样钳制留给主线程接线。
- **唯一免重传平面 = BRDF LUT**：DFG 是 NdotV×roughness 的纯数学积分，与环境辐射无关；
  新旧包 LUT `width` 相同且 `dataBase64` 全等时计划输出 `reuse`（跳过上传）。diffuse 必传。

## 资源预算设计

- **预算对象 = active + pending 合计解码驻留字节**（rgba16float，6 面；与
  `validateRuntimePrefilteredIbl` 同口径：`size*size*6*8`，LUT 为 `w*h*8`）。
  默认上限 `2 × RUNTIME_IBL_MAX_BYTES`（单包合法上限的 2 倍，恰好容纳一次热替换的双份瞬时驻留）。
- **决策顺序（贪心，保质量最大化）**：
  1. 候选全链 + diffuse +（LUT reuse?0:LUT）与 active 合计 ≤ 预算 → `accept`；
  2. 超限 → 按链头截断重定基从 `rawMips-1` 逐档降到 `keptMips=1`，取首个 fit 档 →
     `accept-degraded`（计划携带 keptMips/裁去数/降级后驻留字节）；
  3. `keptMips=1` 仍超限 → `reject`（fail-closed，旧环境继续供帧，无任何状态变更）。
- **pending 超员**：同一时刻至多一个 pending（与 `PbrEnvironmentState` supersede 语义一致）；
  新世代到达时旧 pending 先回滚销毁再入位——单槽队列的"最新优先"即 LRU（多槽 LRU 缓存
  被 I-C15 明确排除，本刀不引入跨环境缓存）。
- **上限不可变**：预算构造后冻结，防止运行时放宽造成隐性驻留增长。

## 回收时序（无泄漏不变式）

世代生命周期：`stage(入位持租约) → commit（新 active 就位后立刻销毁旧 active）|
rollback（候选即销毁）| supersede（旧 pending 先销毁）| dispose（全部销毁）`。

**不变式（测试逐条断言）**：
1. 进入状态机的每个租约（`IblLease`）恰好销毁一次：active、pending、disposed 三态互斥完备；
2. commit 后旧 active 立即销毁（不跨世代滞留），`outstandingLeases()` 回落到 1；
3. reject 的租约由状态机即时销毁（调用方零负担）；rollback/supersede 销毁候选；
4. `combinedResidencyBytes` 在任意 stage/commit/rollback 序列后永不超预算；
5. `dispose()` 幂等；销毁回调抛错时聚合上报（沿 `PbrEnvironmentState` AggregateError 模式），
   其余租约仍被销毁。
6. 租约字节与计划驻留字节不符 → TypeError（字节记账 fail-closed）。

## CPU 参考路径（对拍期望生成器）

现有 prefilter 是纯 GPU（`environmentShader.ts` 的 `environmentImageMain`/`brdfMain`），
无 CPU 对拍物。新增 `lab/iblPrefilterReference.ts`：

- 与 WGSL 同数学单源移植：`hammersley`（32 位 reverseBits）、`ggx`（a=roughness² 重要性采样）、
  `basis`（|n.y|>0.99 换 up 轴）、`cubeDirection`（px-nx-py-ny-pz-nz，UV=(id+0.5)/size*2-1）、
  equirectangular 双线性采样（U repeat / V clamp-to-edge，与 hdrEnvironment 采样器一致）；
- `prefilterPanoramaReference(image, {specularSize, diffuseSize, sampleCount})` →
  specular 每 mip RGB 平面（roughness=level/(levels-1)，`color/weight`，diffuse 权重恒 1、
  采样向 `basis(n, (cosφ√ξy, sinφ√ξy, √(1-ξy)))`，输出 irradiance/π 语义同 WGSL）；
- `encodeRuntimeIblReference(...)` → 合法 `RuntimePrefilteredIbl`（半精度编码：负值钳 0、
  非有限钳 65504，round-to-nearest-even；base64），可过 `validateRuntimePrefilteredIbl`；
- `compareIblReference(expected, actual)` → maxAbsError/maxRelError，GPU 对拍门沿用 J3 的
  0.002 容差经验值（fp16 存储 + fp32 采样差异）。

GPU 对拍闭环（主线程）：CPU 生成小尺寸合成 panorama → `encodeRuntimeIblReference` →
`createPrefilteredEnvironment` 实机上传 → readback → `compareIblReference` ≤ 0.002；
再以探针/状态机计划逐项对照资源数与回收（资源 54→56→54 模式，见 I-C15 证据）。

## GPU 验证计划（留给主线程的精确命令）

本刀不改 GPU 路径；主线程按 I-C15 模式新建 `lab/iC19DynamicIblProduction.ts` +
`scripts/i-c19-dynamic-ibl-frame.mjs`（esbuild bundle → 本地 server → 双轮 1920×1080 实帧），
CPU 侧已备好期望生成器与判定函数，命令形态：

```bash
# 1) CPU 侧（本刀已跑通）
pnpm --filter @bim-studio/deep-engine exec tsc --noEmit
pnpm --filter @bim-studio/deep-engine exec tsc -p tsconfig.lab.json
pnpm --filter @bim-studio/deep-engine exec vitest run src/webgpu/dynamicIblResidency.test.ts lab/iblPrefilterReference.test.ts

# 2) GPU 门（主线程串行执行；新建 iC19DynamicIblProduction 入口后）
node scripts/i-c19-dynamic-ibl-frame.mjs --round=1 --round=2
#   断言：a) reference IBL 上传后 readback vs lab/iblPrefilterReference maxAbsError ≤ 0.002
#         b) 环境热替换序列（A→B→A）逐帧环境 binding 代际正确、资源计数 N→2N→N 回落
#         c) 降级计划（预算 1/2）实机采样的锐利层钳制生效、HDR 值有限
#         d) 每轮前后 outstandingLeases=1、GPU validation 空
#   证据落 test-output/i-series-1001/dynamic-ibl/evidence.json（源哈希 + device epoch + 帧数）
```

禁止本刀执行 GPU 实测与 WASM 重建（主线程统一串行）。

## 交付清单

- 规格本文：`docs/specs/i-c19-dynamic-ibl-cpu-20261001.md`
- 状态机：`packages/deep-engine/src/webgpu/dynamicIblResidency.ts`（纯 CPU、零 GPU import）
- 聚焦测试：`packages/deep-engine/src/webgpu/dynamicIblResidency.test.ts`
  （失效触发矩阵、幂等、LUT reuse、预算 accept/degraded/reject 三分支与边界、
  回收零泄漏、聚合销毁错误、字节记账 fail-closed）
- CPU 参考生成器：`packages/deep-engine/lab/iblPrefilterReference.ts`
- 参考生成器测试：`packages/deep-engine/lab/iblPrefilterReference.test.ts`
  （WGSL 数学逐函数对拍、mip 能量/确定性、编码经 `visitIblBytes` 回验、比较器负例）

## 本轮检查（2026-09-30 CPU 侧闭环）

- 聚焦测试 30/30 通过（`dynamicIblResidency.test.ts` 15：失效矩阵三分类、光源非触发身份锁定、
  幂等、LUT 复用/尺寸不符即上传、accept/accept-degraded/rejected 三分支、预算 2432/2431 边界、
  commit 回收旧世代、reuse 跨世代保 LUT、supersede/stale commit/rollback、热替换序列零泄漏、
  聚合销毁错误、字节记账 fail-closed、畸形租约拒绝；`iblPrefilterReference.test.ts` 15：
  hammersley/ggx/cubeDirection/basis 逐函数对拍 WGSL、双线性 U-repeat/V-clamp、均匀白图全 mip
  守恒、roughness=0 直取、重定基链尾视图、DFG 镜面角 ≈(1,0)、RNE 半精度平局/钳位、
  `validateRuntimePrefilteredIbl` 全包过门、比较器零误差/漂移检测/长度 fail-closed）。
- `tsc --noEmit`（src）0 错；`tsc -p tsconfig.lab.json` 本刀文件 0 错（残留 7 错全部属于其它
  并行组未跟踪文件 `lab/iC23NativeLayeredFixture.ts`，不属本刀、未触碰）。
- `sourceSizeGate`：5 个新文件全部 ≤300 行（260/191/221/122/170）；gate 现有 3 个 failure
  （pbr_layered.rs、contract/types.rs、deviceSession.ts）均属其它组工作树，与本刀无关。
- `runtimePurityGate` 现有 6 个 issue（hdrDisplayCanvas/pipelineCache/virtualTextureFrameBridge
  dom-api）全部属 C21/HDR 线未提交文件；本刀 src 叶零 GPU/零 DOM/零 node 依赖。
- 过程中抓到并修复两个真实缺陷：`reverseBits32` 缺 `>>> 0`（负 ξy 传导至 ggx 长度偏差、
  LUT 负值、diffuse NaN——正是同族清剿的价值）；半精度 subnormal 位移差一（`13-e`→`14-e`）。
- 对比既有底座：失效/预算/回收全部为新增能力，未重复 `PbrEnvironmentState`（帧边界事务）、
  未重复 `createAdmittedTexture`（GPU 准入）、未重复 `validateRuntimePrefilteredIbl`（包校验）。

## 未做与风险（诚实条款）

- 未接线 `PbrRenderer`/`mainBindings`：状态机判定结果到 GPU 上传/采样钳制的胶水属 GPU 刀，
  本刀 CPU 测试不证明实机行为；主线程接线时若发现 `PbrEnvironmentState` 语义冲突，以
  fail-closed 优先（保持旧环境供帧）。
- 未跑 GPU：对拍容差 0.002 是 J3 经验值，非本刀实测；GPU readback 与 CPU 参考在锐利层
  （高频 softbox 边缘）可能超差，届时先核对采样器 wrap/clamp 与 fp16 量化，再议容差。
- 降级"截断重定基"的视觉验收（锐利反射糊化程度）无法在 CPU 侧证明，留给 GPU 双轮截图。
- 光源大改不失效 IBL 是设计裁定而非实测结论；若未来引入"光源影响环境"的特性（如光源烘焙
  进 IBL），该行失效矩阵必须重审。
- 行数门：四个源文件均按 ≤300 行设计，超门即拆分，不进 LEGACY_OVERSIZED。
