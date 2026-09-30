# J2-B4 帧时后继现状核查

日期：2026-09-30。共同七点与 linear PCF 已交付；下一刀只补已有边界优化的 GPU 计时证据，沿用现有测量接口。

## 现状核查

| 六步 | 已有（不重建） | 真实缺口 |
|---|---|---|
| 1. 全仓源码与未跟踪文件 | 已检索 packages/apps 的 CSM、PCF、linear、timestamp 和当前 git status。三族生产采样已接共享混合核；共同 fixture、TS/Native oracle、GPU producer 和 runner 已存在。 | 当前边界 producer 不请求 timestamp feature，也不采 GPU 查询；运行命令墙钟不能证明采样路径收益。 |
| 2. 契约层 | `shadows/types.ts` 与 Native planner 保留宿主合法域；主 TS 624B、Native/DeepSL 336B。`benchmarkSampleSchema.ts` 定义 raw SampleWindow，GPU 不可用必须记录原因；`benchmarkWindowComparison.ts` 要求至少五个完整成对窗口。 | 没有 B4 优化前后、相同输入和真实 shader 身份的原始 GPU 计时窗口。不能把两轮正确性样本直接当性能样本。 |
| 3. 依赖 | wgpu 固定 30.0.1、pollster 1.0.1、serde_json 1.0.151；现有 @webgpu/types、esbuild、Vitest、Chrome/Playwright 已在用。 | 不需要新 benchmark 框架、转译器或性能统计库。 |
| 4. 消费方 | 主 PBR/DeepSL/Native 正式消费 CSM；Web `PbrRendererDiagnostics` → `GpuTimer` 已实现有界异步查询，逐 pass 开关已接生产。Native `GpuContext` 按需请求查询，`renderer/frame.rs` 括夹 Shadow/Opaque，`GpuFrameTiming` → telemetry SampleWindow 已消费。Web lab competitive runner 已消费共同窗口比较器。 | 既有全帧/阶段计时不能自动隔离 CSM fragment 的 18→9 comparison 路径；需要独立测量情景适配，不能把 native Shadow 段（绘制 shadow map）误写成 receiver PCF 采样时长。 |
| 5. 测试与证据 | `j2-csm-linear-parity.mjs`、四项 comparer 测试、Native sampling/oracle、GpuTimer/telemetry/window tests 已存在。提交 `f848945e` 的实际证据同时有 Chrome 2352 和 Native 784 样本；当前 fixture SHA-256 与 receipt 相同。 | 无本优化前后 GPU timestamp 数据、多物理设备或完整 CSM 场景画质证据。单 RTX4060 的两个 API 宿主只覆盖同一物理设备。 |
| 6. 规格与恢复记录 | 已读 j2-b4-current-state、j2-b4-linear-native、0930 交接、remaining、恢复台账；linear 规格文末已记真实完成。 | 旧交接/remaining 仍把 linear/Native 七点写为待补，属于状态漂移。全局任务计数由主线程维护，本审计不修改。 |

## 已验事实

`test-output/interrupted-0930/csm-linear/evidence.json`：`passed=true`、`currentRun=true`，CPU 与跨宿主最大误差均 `5.960464477539063e-8`，linear/nearest 最大差 `0.1666666865348816`。共同 fixture 当前 SHA-256 为 `4c0bd74172d512824f701e4190e16c1a1be429705256a2f0a103bfaac6be0f5d`，与 receipt 一致。

三族 shader source/library 身份和两轮实际样本已随旧证据保留；本次只读核查没有重新执行 GPU，也没有刷新旧证据为本次运行。

## 最小后继方案

复用原边界 fixture 和生产采样函数，在独立 lab/Native test leaf 中测优化前后的完整采样 shader。参照源取已有早退提交的明确前态，保持公共 kernel、ABI、纹理、sampler、深度、UV、输出格式和编译选项一致；只恢复非混合区域下一层 PCF 的旧执行路径。参照/候选 source hash 及精确差异随证据保存，不能手工替换测量结果。

先做三类固定负载：无混合区、混合区、末级，分别覆盖 uniform 和 mixed fragment 输入。用足够大的 receiver 目标放大采样工作量；固定同一 depth-array 与接收输入。预先锁定尺寸、暖机与批次数；结果仍通过共同 CPU oracle。测量目标不是产品截图，检查视图仍只用深色 1920×1080。

Web 复用 `GpuTimer` 的查询资源与收集；Native 复用现有时间戳设施及 `queue.get_timestamp_period()` 单位口径。时间戳只括夹 receiver 渲染 pass，depth writer、资源分配、编译、CPU 等待和 readback 不计入该 pass。查询 unsupported/zero quantization/不足样本逐项记录，不能用墙钟回填。

统计直接消费既有 SampleWindow/compareBenchmarkWindows：至少五个交替顺序的成对窗口，保存每个原始 GPU duration、设备/驱动、fixture/source 身份和 correctness 结果，再报告 p50/p95 与成对差区间。GPU 绝对耗时只能在同宿主内比较优化前后；不同 API 宿主各自报告。完整生产帧的收益需另用现有 PBR/Native telemetry 同场景验证，不从微测量外推 FPS。

初始核查阶段只产出只读结论与方案；后续授权实现见下文。Cargo/GPU 由主线程串行排期。

### 参照源差异核对

已查提交 `e7892afc`：主 TS 原来已有 `blendStart >= split` 的零宽保护，此提交只增加 `viewDepth <= blendStart` 的非混合区早退；Native/DeepSL 同时增加两项。当前三个调用点都已改用 canonical `deepCascadeBlendInactive`。

最窄参照是在测试独立拼接源中把这个 helper 的返回条件从 `blendStart >= split || viewDepth <= blendStart` 改成 `blendStart >= split`，其余完整生产库字节不动。这样只比较非混合区提前返回收益，仍保留零宽安全语义。Native/DeepSL 在正宽夹具上与历史旧路径相同；不能把该参照标作完整历史生产 shader。参照名应写“保留零宽保护、关闭非混合区早退”。CPU 必须检查替换只发生一次、候选真源 hash 与实际组成源相符，以及所有原共同输入仍符合 oracle；不能通过反复试参照挑快结果。

## 已授权 CPU 实现

主线程随后授权独立叶子实现。新增 `fixtures/j2-csm-timing-v1.json` 锁定 1024×512 receiver、4 次 draw/sample、10 帧暖机、16 个 timestamp/sample window、五个成对窗口。六个固定负载为 inactive/blend/last × uniform/mixed；每窗记录真实执行顺序，奇数 reference→candidate、偶数反向。原 4²两层恒定 depth-array/linear sampler 和七个 UV 继续使用，21 个接收位置同时覆盖三 depth × 七 UV，GPU 输出逐点对已有独立 oracle。

同一 `fixtures/j2-csm-timing-entry.wgsl` 由两宿主消费，实际完整 shader/source/library hash 必须跨宿主相同。lab `j2CsmTimingSource/Resources/Probe` 复用 DeviceSession/GpuTimer；Native 新 `src/csm_sampling_gpu_timing_tests.rs` 与 resource 叶子复用既有 GpuFrameTiming，无现有 production 源码改动。主线程登记 bin 的 cfg(test) 模块并负责 Cargo/GPU。

统一入口 `node scripts/j2-csm-timing-parity.mjs` 先运行具名 Native 测试 `j2_b4_actual_native_csm_timing`，再跑 Web 同函数两个候选；每宿主 960 个预注册计时样本。runner 核对实际依赖 source closure 前后不变，默认两端本次执行时 currentRun=true；`--web-only` 与 `--compare` 明确 currentRun=false。

`scripts/lib/j2CsmTimingParity.mjs` 直接调用原 `compareBenchmarkWindows`，检查缺窗、错顺序、零计时、源码漂移和 21 点数值漂移。correctness passed 与 timingComplete 分开；unsupported、零量化或不足样本给 unavailable 原因并使 timingComplete=false。

窗口另存 `observedSamplesMs` 保留真实零量化/不足样本观测。正式 unavailable channel 的 samplesMs 仍为空，不把零值计作有效计时。

CPU 验证：source Vitest 3 项、parity Node 3 项通过；lab tsc、JS syntax、rustfmt 和空白检查通过。Native 模块登记与 Cargo CPU 核验由主线程完成。

## 实际 GPU 计时结果

主线程运行默认统一 runner 通过，`test-output/interrupted-0930/csm-timing/evidence.json`：passed、timingComplete、currentRun 均为 true。每宿主 960 个真实 timestamp，12 个情景/宿主比较均 measured，每个比较完整五对窗口。实际 shader/source、fixture 身份及依赖快照通过，正确性检查通过。

| 负载/宿主 | 参照 P95 中位数 ms | 候选 P95 中位数 ms | 五窗成对 P95 差的 95% 区间 ms |
|---|---:|---:|---|
| inactive-uniform / Web | 0.16896 | 0.08704 | [-0.0833536, -0.0819200] |
| inactive-uniform / Native | 0.217088 | 0.117760 | [-0.1001472, -0.0993280] |
| inactive-mixed / Web | 0.16896 | 0.08704 | [-0.0825344, -0.0800768] |
| inactive-mixed / Native | 0.217088 | 0.117760 | [-0.0997376, -0.0917504] |
| blend-uniform / Web | 0.16896 | 0.16896 | [-0.0006144, 0.0006144] |
| blend-uniform / Native | 0.217088 | 0.217088 | [-0.0045056, 0.0004096] |

inactive 两类固定负载在两个 API 宿主都缩短 receiver pass GPU 时长；blend-uniform 两端差区间均跨零。其余 blend-mixed/last 的变化约 0.001ms 量级，完整 raw 及 12 项统计保留在 receipt，不能从该微小变化扩展收益结论。时间戳按每次 1024×512 receiver pass 内 4 draws 记录，包含该 pass 的 clear/store，不是单次函数调用耗时或产品全帧 FPS。

原 runner 两张 1080 截图的 JSON 长文本超出画布；没有重新执行测量。新增纯 CPU receipt 报告附件 `receipt-round-1.html/.png`、`receipt-round-5.html/.png` 展示同一实际 receipt 的窗口 1/5：12 行、完整每行 16 个 raw sample、统计及范围均在深色 1920×1080 内，已逐张检查，无裁切。可复现展示脚本位于该证据目录 `render-receipt.mjs`，不调用 WebGPU；它不作为新 GPU 测量证据或产品场景画质评分。

本切片补齐单 RTX4060 的同设备函数优化计时；跨物理设备、完整 CSM 场景与真实生产全帧收益仍属后继。
