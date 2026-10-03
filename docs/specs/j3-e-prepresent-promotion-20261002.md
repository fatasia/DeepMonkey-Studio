# J3-E pre-present 三叶候选提升与原矩阵 join(2026-10-02)

owner:J3-E 线路集成者(第 2 次崩溃恢复会话)。本文件只记本会话增量;此前事实以
[glm-handoff-20261001.md](../handoffs/glm-handoff-20261001.md)「J3-E」节与
[test-output/j3-e-candidate-prepresent-retry-20261001/](../../test-output/j3-e-candidate-prepresent-retry-20261001/)
冻结清单为准,不在此重复。

## 断点核查(本会话第一步,证据 breakpoint-verified.json)

- manifest `manifest-frozen.json` SHA-256 = `bda801b9cee8c08f8bce087fbcb9853daa0c05118a0bb3cd1c9109eead1eb335`,与交接一致。
- 三叶**已由前会话 exact-copy 进正式源**,三文件 SHA 与冻结候选、manifest afterSHA 逐一相等:
  - `apps/web/src/viewer/StudioDeepWebGpuBridge.ts` = `f03a8ee747a0eaf8721e70e2b9fb6d7bf2d65d7c835f305b90020d5d6df0e0f2`
  - `apps/web/src/viewer/studioRecoveryCandidate.ts` = `10ab33d6577b8832fb0624289f9ebccb5467373ef49ac9302e47f46da619f648`
  - `apps/web/src/viewer/StudioDeepWebGpuBridge.candidateLoss.test.ts` = `d16d24f0254f35f3582840042b3970ad0bf5437a689fe08bae48044ef6985716`
- 四项候选语义在正式源逐条核实:同 generation/AbortSignal 观察真实 unknown;
  仅原 readiness 三错误消息且已观察 unknown 才等待原 session 恢复;恢复后退役整 host 走完整
  switchTo 候选事务重建;预算按原 session classified→attempt 计数保留到 publish、耗尽 0 时末个
  host 不再携带 recovery 选项。
- 此前 webgpu 两修复仍在位:`deviceSession.ts` = `b26fec06…`(正式36CPU)、
  `probeClipmapPbrController.ts` = `2f961637…`(正式20CPU)。packages/deep-engine/src/webgpu/
  24 个 tracked 修改文件即上述已验工作与本轮 J/C/I 并行改动,无候选残留。

## 提升(候选 GPU 前断点续验,证据 promote-verified.json)

- 正式 CPU:`StudioDeepWebGpuBridge.test.ts` + `candidateLoss.test.ts` + `prepareStudioRendererCandidate.test.ts`
  = **70/70 通过**(43+6+21)。
- `pnpm --dir apps/web typecheck` 通过。

## 上一会话 GPU 失败的定性(本会话新事实,两轮 diag 实证)

前会话两 fresh 失败与 diag 失败均为 `HDR drift 0.2132568359375`,值逐 run 完全相同;
其 receipt 引擎通道全等、呈现成功。两轮带 diffFacts/frameId 的诊断
(`diag-…18-03-45-358Z`、`diag-…18-06-56-860Z`)给出决定性事实:

- **before=frame-7 vs after=frame-7(跨 3 backend、2 次设备恢复、2 个新 GPUDevice)→ drift 恰为 0**(位级相等);
- 同一后端 frame-7 vs frame-15(+8 帧)→ drift = `0.2132568359375`。

结论:`.2132` 是 **TAA Halton(revision+1,2/3) 逐帧子像素相位的测量伪差**,不是恢复缺陷、
不是纹理复用残留。原 probe 两侧捕获可能落在不同帧号(rAF/发布竞态),边缘像素必然差出该常值;
≤1e-6 门实质要求位级相等,只有同帧号捕获才可比。恢复链路本身正确。

**probe.ts 相位修正**(test-output 测量器,非生产源):`867fd2b16589755a83d06ae53a4f2c9d0d2fa8fa848eac89a61128dee54e1780`
→ `f03948b2904640dd83f81087467387e21c835832dedb93d304c8eb3e8c6bd968`。两侧捕获统一渲染+轮询到
同一目标帧号(frame-8)后比较,gate ≤1e-6 不变,evidence 增加 `hdrFrameIds`。诊断 runner 同时补上
成功路径的 `__j3CaptureContinue` 放行(此前只在失败分支可达)。失败 run(16:53r2/16:55r1/16:23diag)原样保留。

## 两 fresh(用户指定命令,两独立进程,证据 round1-done.json / round2-done.json)

- 进程1 `run-2026-10-01T18-11-59-268Z`:两轮全过,hdr=0,frame-8==frame-8,attempts=2,notifications=2,
  device-1→device-5,createdDevices 5/createdBackends 3,staleEventsRejected=true,disposedResourceCounts 全 0。
- 进程2 `run-2026-10-01T18-12-45-996Z`:两轮全过,同上全绿。
- 两 run evidence `drifted:[]`(1116 源无中途变更)。前会话失败日志原样保留。

## 原矩阵 11 cell join(证据 join-result.json)

`node scripts/j3-unknown-loss-runner.mjs --validate …/join-receipts.json` →
**matrixComplete=true,11/11 measured,0 invalid**。首次 Web6+Native5 全量正式核过。

- Web6:pre-present 用本轮 fresh(process1 round1);其余 5 行按交接保留 2026-10-01 measured-batch
  (15:12/15:15),不伪造全源 fresh。
- Native5:`native-actual-audit.json` rounds[0].receipts(2026-10-01 actual 两 fresh)。
- editorDomains:web 侧 15 个非豁免域——4 个 observable 以本 receipt 引擎通道/HDR 证据声明
  (method=engine-channel-readback),11 个 structural 引用真实 controller CPU 域证据;本会话现跑
  恢复域 5 文件 **22/22**(`editor-domain-join-20261002.log`)绑定当前源;6 个豁免域不 claim verified。

## 剩余(remaining.json,帧时本批禁测)

帧时/frame-interval 渠道(需独占 GPU 批)、驱动显存标定、上传量(uploadedBytes/gpuUploadTimeNs 仍 null)、
≥5 成对窗口统计、编辑器域 GPU 升格(15 域 CPU 未升格,6 域豁免/未裁决)、同 session 多 epoch 扩展。
真实 unknown driver fault 与标定前 VRAM 阈值维持合同 excluded。完整清单与证据索引见
[test-output/j3-e-prepresent-promote-20261002/remaining.json](../../test-output/j3-e-prepresent-promote-20261002/remaining.json)。

## 纪律记录

本会话未 commit/push/reset/clean/stash;四项用户资产未触碰;GPU 全程单集成者串行
(两诊断→两 fresh→join,无并行 GPU);每个里程碑先落盘再继续;禁 cargo 遵守。

---

# 增量:剩余子缺口批(同日第二会话,J3-E 线路集成者)

约束:本机 GPU 有并行负载(C8 归因/I-C23 对拍/G2-S2b),帧时类测量继续禁测;
显存字节与轮次扩展不受负载影响可做;禁 cargo(防并行会话 target 锁冲突)。
现状核查与全部里程碑证据:[progress-01.json](../../test-output/j3-e-prepresent-promote-20261002/progress-01.json)。

## 驱动显存标定(三窗,含两 fresh)

复用四阶段驱动内存观测(`j3-e-driver-memory-phases-20261001` 冻结 runner/采样器
原样复跑,冻结 SHA 未动;两锚点核查通过,pwsh+Chrome 就绪)。三独立窗口全
measured,PDH「GPU Process Memory/Dedicated Usage」树求和,counter 身份三窗一致:

| 窗口 | 作者基线 | 替换后 | dispose 后残留 | 残留-基线 |
|---|---|---|---|---|
| 首跑 10-01 07:12 | 246,456,320 B | 435,437,568 B | 264,192,000 B | +17,735,680 B |
| 本批 fresh-1 18:32:03 | 237,424,640 B | 435,425,280 B | 259,973,120 B | +22,548,480 B |
| 本批 fresh-2 18:32:56 | 237,428,736 B | 435,429,376 B | 264,183,808 B | +26,755,072 B |

**量级声明(不是零泄漏认证)**:destroy+dispose 后驱动残留 16.9–25.5 MiB
(占 deep session 增量 ~8.5%–13.5%),dispose 释放 171–175 MiB;所有权账本
resourceCount/estimatedBytes 已 0,驱动/Chrome 池允许保留底噪。标定预算
`driverLeakBudgetBytes = 64 MiB`(三窗最大残留 2.5 倍);任一未来同口径 fresh
窗残留超 64 MiB 即超预算、须开专项泄漏批。冻结 phaseMemory.mjs 预算常量保持
first-run-calibration-pending 不动,标定数据是独立产品:
[calibration-v1.json](../../test-output/j3-e-vram-calibration-20261002/calibration-v1.json)。
可测范围:PDH 计数器树本机可测;per-renderer 归因/Native 树/帧时不含。

## 上传量字段生产接线(源码级,GPU 实测留下一 cargo 窗口)

现状核查定位:null 是**硬编码**——`initial_preparation.rs:108` 直接写
`"gpuUploadTimeNs":null,"uploadedBytes":null`,从未接线计量。
最小实现(不改既有口径,`scope` 声明原样保留):

- `initial_preparation.rs`:Clock 增 `upload_bytes/upload_elapsed_ns` 与
  `note_upload_bytes/upload_timed`;json() schemaVersion 1→2,两字段改实测值,
  新增 `uploadedBytesCoverage`/`gpuUploadTimeClockId=host-monotonic-upload-phase`/
  `gpuUploadTimeNote` 声明;单元测试改断言 `uploadedBytes==160`、
  `gpuUploadTimeNs>0`。**不把 host elapsed 冒充纯 GPU 时间**:字段声明含
  CPU 调用/驱动阻塞/await 等待,纯 GPU 传输归因(timestamp-query)保持 excluded。
- `init.rs` 三处 renderer 边界直发上传接入计量:①section_uniform write_buffer
  (16 B);②GpuIblEnvironment 构造(环境纹理 resident_bytes)+cluster grid
  write_buffer;③BLAS/TLAS encoder submit(计时;字节 device-accounted)。
- `device_loss_unknown_receipt.rs:79` 的 null **不动**:那是 unknown 矩阵
  receipt 的恢复窗字段,与启动归因六段窗口不同口径,留独立批。

诚实声明:本批禁 cargo,未编译未跑 GPU 收据——非 null 的 GPU 实测是下一
cargo 窗口动作(命令预登记:先 `cargo test --lib renderer::initial_preparation`,
再按 jc-i 2026-10-01 同命令复跑 startup 归因收据断言两字段 >0)。详见
[upload-wired.json](../../test-output/j3-e-prepresent-promote-20261002/upload-wired.json)。

## 15 域 GPU 升格裁决(0 升格,逐域原因)

11 个 web structural 域逐域裁决:**0 个可升格**。本批 receipt 引擎通道
(channels()/同帧号 HDR/资源账本)不可达任何 structural 域状态,且不得借 HDR
宣称结构域。逐域原因三类:①域对象不在探针最小场景(measurements/dashboard/
behavior-graph/publication/interaction/undo);②引擎无公开读写 API(selection
仅类型 import、scene-name 在 editor 层;Native 侧同域已用 state/package 内嵌);
③约束/策略挂在持久 author 控制器上,读回不构成恢复绑定(camera-constraints/
animation-policy)。每域升格前置 = 引擎 API+探针装配+恢复事务 capture/apply
+recovered 读回,四件齐逐域独立验收:
[domain-upgrade-adjudication.json](../../test-output/j3-e-prepresent-promote-20261002/domain-upgrade-adjudication.json)。
4 个 observable 域由本批 triple-epoch receipt 继续以 engine-channel-readback
背书;6 个豁免域维持豁免。

## 同 session 三连续 epoch(多 epoch 扩展)

派生 probe(`probe-triple.ts` SHA `406497f1…`,基础 probe SHA f03948b2 冻结不动):
epoch-2/epoch-3 分别在 backends.length===2/3 的 validateFrame 做 pre-present
注入,同相位对齐口径(两侧原子捕获同一目标帧号 frame-8)。两独立进程四轮全过:

- hdr drift = **0**(frame-8/frame-8,四轮一致);
- device-1 → device-7,4 backends(3 个恢复候选),lossCallbacks=3,attempts=3;
- fatalCalls=0,staleEventsRejected=true,disposedResourceCounts 全 0,
  终态 backendSessionStates=[disposed,disposed,disposed,ready]。

跨 epoch 结论:三连续 unknown 全部在预算内自动恢复,最终 present 与 epoch-1
前 HDR 位级相等。**测量方法新事实**:首跑曾以同常值 `0.2132568359375` 失败,
定性为两步 settle→hdr 的 results 替换竞态(帧相位伪差同族,非恢复缺陷);
派生 probe 改**原子同帧捕获**(同一 results 对象上校验帧号+取字节)后 4/4 全过。
冻结基础 probe 不动,竞态记观察项(remaining-02)。失败 run 原样保留。
证据:[multi-epoch-done.json](../../test-output/j3-e-multi-epoch-20261002/multi-epoch-done.json)。

## 剩余(v2)

帧时与 ≥5 成对窗口统计(独占 GPU 批)、上传字段 GPU 收据实测(下一 cargo
窗口)、11 域逐域升格实施、mixed unknown/destroyed 序列、frozen probe 竞态
升级评估。完整清单:
[remaining-02.json](../../test-output/j3-e-prepresent-promote-20261002/remaining-02.json)。

## 本批纪律记录

未 commit/push/reset/clean/stash;四项用户资产未触碰;禁 cargo 遵守(未编译
任何 native 目标);帧时零测量;GPU 串行(显存标定两 fresh → 三 epoch 两
fresh,每次一个 Chrome 实例,与并行负载无帧时竞争);每里程碑先落盘。

---

# 增量:上传字段 GPU 收据实测(同日 cargo 窗口,J3-E 线路 cargo 实测者)

前提:上一批已完成源码接线(`initial_preparation.rs` schemaVersion 2 +
`init.rs` 三处直发上传计量点),命令预登记于
[upload-wired.json](../../test-output/j3-e-prepresent-promote-20261002/upload-wired.json)。
本批为全仓唯一 cargo 用户,串行执行,GPU 无并行竞争。

## 预登记命令的一处修正(不算偏离)

预登记单测命令写 `--lib renderer::initial_preparation`,实测 lib 侧无该模块
(`--lib` 过滤 0 tests/712 filtered out)——renderer 走 bin 侧双编译
(`lib.rs:78` 注释:renderer 的 `crate::` 引用走 bin 侧)。改用
`--bin deep-engine-native`(与 GPU 收据同目标),命令意图不变。

## 前批接线的两处真实缺陷(本窗口编译/断言时暴露,已最小修复)

1. `init.rs:149` `cast_slice(&view.clipping).len()` 输出泛型未约束
   (E0283:`len()` 不约束 B),bin test 编译失败。前批禁 cargo 未编译故未暴露。
   修复:`cast_slice::<f32, u8>`,与同分支 `write_buffer(&[u8])` 字节口径一致
   (16 B)。同族排查:全 src 仅此一处 `cast_slice().len()` 未约束模式。
2. `initial_preparation.rs` 单测只 `note_upload_bytes(96)` 却断言
   `uploadedBytes==160`,断言必失败(缺一次 note,与登记期望 160 矛盾)。
   修复:测试内补 `note_upload_bytes(64)` 合计 160;生产代码未动。

## 单测与 check

- `cargo test --bin deep-engine-native renderer::initial_preparation -- --nocapture`
  → **5 passed / 0 failed**,含断言 `uploadedBytes==160`、`gpuUploadTimeNs>0`
  (非 null)、`gpuUploadTimeClockId==host-monotonic-upload-phase`、
  `schemaVersion==2`。
- `cargo check --tests` 通过(仅既有 warnings)。

## GPU 收据两 fresh(jc-i 2026-10-01 同命令,证据 upload-gpu-verified.json)

`J3_WINDOW_GPU_TIMING=on` + `J3_WINDOW_NATIVE_OUTPUT` 下
`--bin deep-engine-native --locked j3_gate_e_window_events_present --ignored`。
每 round 为独立子进程(全新 NativeApp 窗口),8 窗(2 fresh × before/after
× 各 1)全部 measured、committed、HDR 相对差 0,RTX 4060/Vulkan:

| round | 侧 | epoch | uploadedBytes | gpuUploadTimeNs | resourcePrepare |
|---|---|---|---|---|---|
| 1 | before | 1 | 32,016 | 2,522,900 | 1747.4 ms |
| 1 | after | 2 | 32,016 | 1,984,300 | 1697.0 ms |
| 2 | before | 1 | 32,016 | 1,906,200 | 1651.0 ms |
| 2 | after | 2 | 32,016 | 1,847,800 | 1687.5 ms |

量级:正式四资源窗口 1651–1747 ms 落在 jc-i 基线 1544–2015 ms host-elapsed
区间内;上传段 host elapsed 1.85–2.52 ms 仅占同窗 ~0.1%,与「section uniform
16 B + IBL 环境纹理 resident 估计 + cluster grid」的直发字节量级相容。
cargo 子串过滤同命令额外跑过 `*_present_retry` 变体,4 窗附加上传收据同全部
非 null(retry before 窗含注入失败+重试,2656.5 ms 偏大属预期),记附加证据
不替换上述两 fresh 断言。

## 口径一致性(逐条实证,未越界)

- `scope` 字符串逐字保留(events-round-1 grep 实证)。
- `gpuUploadTimeClockId=host-monotonic-upload-phase`,note 明示含 CPU 调用/
  驱动阻塞/await 等待;纯 GPU 传输归因(timestamp-query)**保持 excluded**,
  未把 host elapsed 冒充纯 GPU 时间。
- `uploadedBytesCoverage` 声明 device 级 create_buffer_init 与 BLAS/TLAS
  encoder 拷贝不入字节账,与 quality_telemetry 既有口径一致。
- `device_loss_unknown_receipt.rs:79` 的恢复窗 null 按预登记不动(不同口径,
  留独立批);`jc-i-continuation` 未改。
- schemaVersion=2、`deep-engine.native-initial-preparation` 收据落盘
  [test-output/j3-e-upload-gpu-20261002/](../../test-output/j3-e-upload-gpu-20261002/)
  (events-round-1/2 + events-retry-round-1/2 + 运行日志 + milestone-1 +
  upload-gpu-verified.json 含全量 SHA-256)。

## 本批纪律记录

未 commit/push/reset/clean/stash;四项用户资产未触碰;GPU 全程串行(本窗口
全仓唯一 cargo 用户);无失败 run(单测修复后首跑即过);每里程碑先落盘
(milestone-1 → GPU run → upload-gpu-verified.json → 本节)。

---

# 增量:帧时与 ≥5 成对窗口统计(同日 GPU 空窗窗口批,J3-E 线路帧时集成者)

关闭 remaining-02 前两项:帧时渠道实测、≥5 成对窗口统计。现状核查与全部
里程碑证据:[progress-01/02/03.json](../../test-output/j3-e-frame-time-20261002/progress-03.json)。

## 执行方式(禁 cargo 前提下的冻结二进制直跑)

- 本批禁 cargo:未调用 cargo、未触发重编/目标目录锁。复用上传 GPU 收据批的
  最终构建 `deep_engine_native-2a9add58b1b72ff0.exe`
  (SHA-256 `6cc787e7…a70fdc`,2026-10-02 02:58:52,即产出该批全部收据的
  同一二进制),测试 harness 直跑,子进程经 `current_exe()` 使用同一冻结件。
- 源身份:`windowEvents.sourceHash` = `e2112f34…`(8 个 window-probe 源
  canonical 摘要),该 8 源构建后零变更(`find -newermt` 实证)。
  **如实声明一处漂移**:并行 GI 线在构建后修改 `probe_gi_grid.rs`(14+/8-,
  不在 8 源内,被 init.rs GI-grid decode 分支引用);收据按 02:58:52 冻结
  构建口径,不冒充当前树全量身份。场景同 golden package(packageHash
  `7089eba4…`,与上传批/jc-i 基线一致)。

## 轻负载窗口口径(不冒充独占)

并行线 H-C7-P3/E4 UI 为非 GPU 重载;每 run 前后 nvidia-smi 快照 GPU util 0%
(`run-N.load-*.txt` 原样保留)。本节全部帧时数字按**轻负载窗口**口径,
非独占 GPU 基准。

## 帧时数字(6 成对窗口池化,P50/P95,nearest-rank)

RTX 4060 Laptop / Vulkan / driver 595.79;每侧每窗 cpu-submit 13、
gpu-timestamp 13、frame-interval 12 样本。steady = 样本∈(3,20]ms
(剔除首帧启动间隙与预热重绘;原始样本全量在 window-stats.json):

| 通道 | before(原 device 侧) | after(恢复候选侧) |
|---|---|---|
| cpu-submit (host-monotonic) | P50 1.3825 / P95 2.2004 ms | P50 1.3568 / P95 2.2619 ms |
| gpu-timestamp(per-frame pass 总时间) | P50 0.4874 / P95 0.6267 ms | P50 0.4844 / P95 0.6195 ms |
| frame-interval all | P50 6.6941 ms | P50 6.6903 ms |
| frame-interval steady | P50 6.8593 / P95 7.4071 ms | P50 6.9258 / P95 16.7404 ms |
| present | unavailable(合同:wgpu_surface_present 无合成完成时间戳) | 同左 |

host render/present span(`Renderer::render` 含真实 surface present 返回):
窗口首帧 4.9826–6.0223 ms(P50 5.4945);恢复后首帧 4.9455–6.0553 ms
(P50 5.2391)——两者均落在 jc-i 20261001 timing-off 基线 4.9721–6.1321 ms
区间,不合并口径。loss→恢复时长六窗 1780.8–1893.4 ms。

## ≥5 成对窗口统计表(6 个独立 fresh,未伪造 rounds)

成对窗口 = 1 个 fresh 子进程收据(before/after 两侧四通道);3 次父调 ×
每次 2 fresh。稳态 frame-interval P50(after−before,ms):
**−0.092 / +0.042 / +0.068 / +0.075 / +0.087 / −0.080(均值 +0.017)**。

| 窗口 | before steady P50 | after steady P50 | 首帧 span | 恢复首帧 span |
|---|---|---|---|---|
| run-1-fresh-1 | 6.867 | 6.775 | 4.9826 | 5.2391 |
| run-1-fresh-2 | 6.835 | 6.877 | 5.3090 | 4.9455 |
| run-2-fresh-1 | 6.875 | 6.943 | 5.4945 | 6.0553 |
| run-2-fresh-2 | 6.720 | 6.795 | 5.7030 | 5.3487 |
| run-3-fresh-1 | 6.681 | 6.768 | 5.5594 | 5.2447 |
| run-3-fresh-2 | 6.918 | 6.838 | 6.0223 | 5.2059 |

六窗全过:passed、HDR 相对差 0、realCallbacks=1、stale 拒绝=true、
attempts=1、strategy=destroyed-native-window-rebuild。gpu-timestamp 通道
native 侧可用(与 web 侧 unavailable 不同);present 合成完成时间戳不可得
为合同 unavailable,未伪造。

## 验收结论(如实)

恢复前后各通道分布重叠,成对稳态 P50 差均值 +0.017 ms、符号混合,无系统性
差异信号;**帧时预算仍 calibration-pending,不宣称改善/劣化**(预算定标是
显式产品决策)。原始逐窗样本+汇总+成对差值+证据 SHA 见
[window-stats.json](../../test-output/j3-e-frame-time-20261002/window-stats.json)
与 [progress-03.json](../../test-output/j3-e-frame-time-20261002/progress-03.json)。
J3-E 行剩余见 [remaining-03.json](../../test-output/j3-e-frame-time-20261002/remaining-03.json):
11 域逐域升格实施、mixed unknown/destroyed 序列、帧时预算定标;
真实 unknown driver fault 维持永久排除;`jc-i-continuation` 未改。

## 本批纪律记录

未 commit/push/reset/clean/stash;四项用户资产未触碰;禁 cargo 遵守
(冻结二进制直跑,零重编);GPU 串行(三次父调逐次,run 间快照 0% util);
帧时数字全部标注轻负载窗口口径;每里程碑先落盘
(progress-01 → 逐 run → progress-02 → window-stats → progress-03 → 本节)。
