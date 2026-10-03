# F1 帧图 coverage / 常规回执 / 上传与可见量读数 — 交付报告(2026-10-02)

> 任务行:`F1/B1/T01/T25:已接计时之后补真实执行 coverage、常规 frameGraphReceipt、内部上传/可见量读数;无新增同步等 GPU`
> 底座:`2caab70b`(F1 逐 pass GPU 计时)、`74432bca`(t25 桥接通)
> 证据目录:`test-output/f1-coverage-20261002/`(progress-01..04 + gpu-readings-r1/r2/r3-timing.json)
> 纪律:未动 cargo;未做帧时测量;零新增 GPU 同步;未改 `docs/specs/jc-i-continuation-20261001.md`;未 commit/reset。

---

## 一、现状核查(六步,详见 progress-01-survey.json)

| 步骤 | 结论 |
|---|---|
| 1 全仓 grep | `frameGraphReceipt` 5 处消费:pbrRendererTypes(FrameMetrics 字段)、pbrRenderer(构建)、RendererDiagnosticsPanel(FrameGraphSummary)、StudioDeepQualityTelemetry(passCount 口径);计时底座 pbrFrameReceipt/gpuTimer/pbrTimedPassIds/pbrFramePlanExecutor 已在位 |
| 2 契约层 | `createPbrFrameReceipt` 已收 `executedPassIds` 第 7 参(底座留的 coverage 钩子);T01 schema(`qualityTelemetry.ts`)已定义 `visibleInstances: number \| null`,TS 桥恒传 null |
| 3 依赖 | vitest 4.1、playwright-core(既有 GPU 探针惯例 `deep-gpu-stage-smoke.mjs`)已在用 |
| 4 消费方 | `executedCapturePassIds`(pbrRenderer:567)已产出真实编码集并喂入回执;但回执被 `performanceTelemetry.enabled` 双门控 |
| 5 测试与证据 | pbrFramePlanExecutor/gpuTimer/StudioDeepQualityTelemetry/RendererDiagnosticsPanel 测试在位;`test-output/t25-panel` 既有 T25 证据 |
| 6 规格 | `jc-i-continuation-20261001.md:249-252` F1 派出记录;引用的 expansion-plan 文档在 handoffs 下不存在 |

**已有(不重建)**:逐 pass GPU 计时全链(marker 括夹/槽池/回执 perPass/T25 面板 Top-8)、上传字节读数(`chunk-stream-residency-delta`:桥侧 `chunkStreaming.residentGpuBytes` 差分 → T01 `uploadedBytes`,已接)、剔除批计数(FrameMetrics `frustumCulledBatches/hiZOccludedBatches`)。
**真实缺口**:①无独立"登记 vs 执行差集"读数结构;②回执非常规(仅诊断模式);③可见量无任何读出通道(T01 `visibleInstances` 恒 null、coverage 恒 "unavailable")。

## 二、逐缺口实现

### 缺口① 真实执行 coverage — 新叶 `pbrFrameExecutionCoverage.ts`(66 行)

- `computePbrFrameExecutionCoverage(plan, executedPassIds, frame)` → `{ frame, planHash, registeredPassCount, mappedPassCount, executedPassCount, notExecutedMappedPassIds, executedCoverageRatio }`。纯 CPU 量读数,零时间维度,零 GPU 同步。
- fail-closed:执行集 ⊄ 映射集抛错(与回执同一"单一 pass 身份来源"约束);frame 非法抛 RangeError。
- 挂载:`FrameMetrics.frameExecutionCoverage`(pbrRenderer 每帧产出,与回执同源 executedPasses)。
- 导出:`@bim-studio/deep-engine/webgpu`(`computePbrFrameExecutionCoverage` / `PbrFrameExecutionCoverage`)。

### 缺口② 常规 frameGraphReceipt — pbrRenderer 双门控去除

- pbrRenderer:513 计划门控 `frameCapture || performanceTelemetry.enabled` → **恒构建**(`captureForFrame` 内部 key 缓存,常规帧只付一次字符串比较;仅特征/尺寸变化才付计划构建)。
- pbrRenderer:812 回执门控 `capturePlan && performanceTelemetry.enabled` → **`capturePlan`**(每帧产出)。
- `pbrFrameReceipt.ts` 加可选第 7 参 `timingAvailability`(`"missing"` 缺省,**历史 reason 逐字不变**;`"deferred-to-gpu-pass-timings"` / `"not-requested"` 供常规帧准确声明缺测原因)。renderer 按 `passTimingEnabled` 二选一。
- 回执语义:常规回执不含 timestamp;已编码 pass 的样本显式 unavailable 并注明「计时经 gpuPassTimings 异步发布」或「本帧未请求」;未编码 pass「pass not encoded on this frame」;未映射槽位保留底座中文原因。不伪零。

### 缺口③ 上传/可见量读数

- **上传字节:已有(不重建)**。chunk 流驻留差分通道已接(T01 `uploadedBytes` 口径 `chunk-stream-residency-delta`),FrameMetrics 已有 `transientTextures`/`deviceResourceMemory`。本次仅核查确认,未重复建设。
- **可见量:新读出通道 `FrameMetrics.visibleDraws`** = `{ drawCalls, triangles, frustumCulledBatches, hiZOccludedBatches }`(主 pass 包体 `packets.draw` 的 CPU 编码量 + 本帧剔除批计数,量非时)。GPU 逐实例幸存数需遮挡读回(= 新 GPU 同步,任务禁止)→ **不提供**;T01 `record.visibleInstances` 保持 null,不把 draw 量伪称逐实例。
- 桥升级(`StudioDeepQualityTelemetry.ts`):`coverage.visibleInstances` 值域 `"unavailable"` → `"main-pass-draw-calls" | "unavailable"`;status 透传 `latestExecutionCoverage` / `latestVisibleDraws`(可选字段,旧 fixture 兼容)。
- 面板(`QualityTelemetryPanel.tsx`):「可见实例(恒未接入)」格升级为「可见绘制(draw)」——口径可用时显示 drawCalls,title 声明代理口径与逐实例的区别;不可用仍显式「未接入」。

## 三、测试数

| 域 | 文件 | 结果 |
|---|---|---|
| deep-engine 新叶 | pbrFrameExecutionCoverage.test.ts | 5 passed(新) |
| deep-engine 回执域 | pbrFramePlanExecutor.test.ts(含新 deferred/not-requested reason 用例+缺省路径逐字不变断言) | 24 passed |
| deep-engine 计时 | gpuTimer.test.ts | 11 passed |
| deep-engine renderer 回归 | pbrRenderer{DeviceEpoch,Disposal,Features,ProbeFactory,VirtualTextures}+pbrFrameCaptureReadback | 35 passed |
| apps/web 桥 | StudioDeepQualityTelemetry.test.ts(含新 coverage/visibleDraws 直通用例 ×2) | 11 passed |
| apps/web 面板 | QualityTelemetryPanel.test.tsx | 9 passed |
| apps/web 消费方回归 | StudioDeepPerformance.test.ts + RendererDiagnosticsPanel.test.tsx | 15 passed |
| **合计** | | **110 passed, 0 failed** |

类型检查:`deep-engine tsc --noEmit` 通过;`apps/web tsc --noEmit` 通过。

## 四、GPU 真机读数(playwright + Chrome WebGPU/Vulkan,640×360,静态 16 实例)

探针:`apps/web/scripts/f1-coverage-gpu-probe.mjs`(读数全为量,非时序;与并行负载共存)。

| 轮次 | 条件 | 关键读数 |
|---|---|---|
| r1 | 诊断关(常规帧) | 每帧有 receipt+coverage+visibleDraws;frame8:registered 12 / mapped 6 / **executed 6**,ratio 0.5,planHash `cfae37ce`,notExecuted `[]`;visibleDraws `{drawCalls:1, triangles:29440, culled:0/0}`;8 帧 coverage 6/12、draws 1、tris 29440 逐帧恒定 |
| r2(fresh) | 新浏览器实例 | 与 r1 **全等**:executed set / planHash / visibleDraws / reasons / 8 帧逐帧读数 |
| r3 | `gpuPassTiming:true` | gpuPassTimings 帧1 unavailable(读回滞后)→ 帧2起 **measured 6 pass**;回执 opaque 样本 reason 变为 `pass timing published asynchronously via gpuPassTimings`;coverage/回执/可见量照常每帧产出 |

两轮 fresh 量级完全一致 → 稳定验收通过。r1 与 r3 差异仅在 timing 通道声明,读数本体一致。

## 五、F1 行剩余(诚实清单)

1. **GPU 逐实例幸存数(T01 visibleInstances 真值)**:需 HiZ/visibility 计数的 GPU 读回,即新增同步——超出本行禁令,未做。当前 WebGPU 端 coverage 诚实声明 `main-pass-draw-calls` 代理口径;Native 端仍按其自身通道。
2. **未映射 6 槽**(deform/visibility/shadows/cluster-lights/build-hiz/publish-hiz)的生产执行器接入:属底座既定映射路线(第一切片边界),非本行范围;coverage 现在让这些槽位的"登记但未执行"逐帧显式可见。
3. **directClear 帧的差集**:directClear 时执行集仅 `{opaque}`,coverage 会如实给出较大 notExecutedMappedPassIds——语义正确(合法跳过显式可见),未做特判美化。
4. 帧时类测量按任务禁令未做;真机读数与并行负载共存,r1/r2/r3 pageErrors 均为 0。

## 六、改动文件

**新增**:`packages/deep-engine/src/webgpu/pbrFrameExecutionCoverage.ts`、`.../pbrFrameExecutionCoverage.test.ts`、`apps/web/scripts/f1-coverage-gpu-probe.mjs`、`test-output/f1-coverage-20261002/*`。
**修改(全部加法)**:`packages/deep-engine/src/webgpu/pbrFrameReceipt.ts`(可选参数+reasons 表,缺省路径不变)、`.../pbrRendererTypes.ts`(FrameMetrics +2 可选字段)、`.../pbrRenderer.ts`(两处门控+挂载+import)、`.../index.ts`(+3 导出)、`.../pbrFramePlanExecutor.test.ts`(+1 用例)、`apps/web/src/viewer/StudioDeepQualityTelemetry.ts`(+2 直通字段+值域扩展)、`.../StudioDeepQualityTelemetry.test.ts`(+2 用例)、`apps/web/src/components/QualityTelemetryPanel.tsx`(1 格升级)。
