# DE26/B04 第一切片 · 接真实临时纹理复用(帧内 transient 纹理池)

日期:2026-09-17 · 分支:dev-studio · 状态:纯逻辑切片完成(池+合同+可观测+测试);真实 renderTargets 切换与像素/帧时验证归真机门禁切片。

## 1. 任务定义(权威原文)

> transientSlot 尚无生产分配消费证据。依据 B03 兼容键复用 GPUTexture;区分跨帧 history 与帧内目标,
> 按 queue 生命周期回收。通过标准:分配计数/估算 bytes 实际下降;像素和帧时不退化,记录含 staging 峰值。
> 边界:resize、设备丢失、并行候选和失败提交不能复用在途纹理。

B03(`pbrFramePlanResources.ts` + `pbrFramePlanExecutor.ts` + `renderGraph.ts` 的 `transientSlot`/`aliasKey`)
只完成了计划侧声明,没有任何运行时分配/消费。本切片把"分配/消费"落成池本体。

## 2. 合同

### 2.1 池键 = B03 兼容键(完整、显式)

池键与 `renderGraph.ts` 的 `aliasKey` 注释同口径——**完整兼容键,缺一维即异键**:

```
format | width x height | sampleCount | usage 位掩码
```

尺寸维度由调用方按 B03 `sizeRole` 推导后传入(`surface` 继承主帧、`half` 走 `ambientOcclusionHalfSize`,
同 `resolvePbrFrameResourceSizes`);池本身不做尺寸推导,避免第二套推导源。
`framePlanUsageFlags()` 把 B03 计划层 usage 字符串映射为运行时位,未知字符串抛错。

### 2.2 history 与帧内目标的区分(双重排除)

- 显式列举:`PBR_HISTORY_TRANSIENT_EXCLUDED = ["previous-hiz", "next-hiz", "temporal-hdr"]`(任务权威边界;
  注意 `temporal-hdr` 是 TAA 双帧 ping-pong,虽无 B03 `historyRole` 标注,仍按跨帧 history 排除)。
- 运行时兜底:凡 B03 合同带 `historyRole` 的条目一律拒绝(`isPbrTransientPoolEligible`)。
- 池只回收自己 `acquire` 发出的纹理(`release` 校验 handle 归属),外部纹理无从入池。

## 3. 生命周期(queue 生命周期口径)

```
beginFrame() → acquire()…release()… → endFrame(committed)
```

- `release` 只把纹理标记 `pending-return`;**回池发生在 `endFrame(true)`**,即本帧 `queue.submit`
  之后——复用必然跨帧边界,帧内生命周期重叠的同键请求一律新建(不做帧内共享,fail-closed)。
- `endFrame(true)` 前若仍有 `in-flight` 纹理:抛错(校验先于状态翻转,调用方可修正后重试)。
  每张纹理必须显式 `release` 或整帧按失败处理,禁止静默吞掉。

## 4. fail-closed 边界矩阵

| 边界 | 行为 |
|---|---|
| surface resize | `invalidateAll("surface-resize")`:空闲+在途全部销毁,开着的帧作废,epoch+1,下次 acquire 全新重建 |
| 设备丢失 / epoch 更迭 | `invalidateAll("device-lost")` 或 `invalidateAll("epoch-advance")` 同上;且 `session.state !== "ready"` 时 `acquire` 拒绝服务 |
| 失败提交(pass encode throw) | `endFrame(false)`:本帧接触过的全部纹理(在途+挂起回池中)销毁,绝不进空闲列表,计入 `discardedCount` |
| 并行候选(两个 renderer) | 池实例按 `DeviceSession` 归属,无任何全局注册表;两池纹理对象互不相交 |
| scope 误用 | 未 `beginFrame` 即 acquire、重复 begin、重复 release、释放非本池纹理,全部抛错 |
| history 资源 | `acquire` 直接抛错,永不入池 |

## 5. 可观测

`PbrTransientTexturePool.stats` 返回冻结快照(形态对齐 `EnginePerformanceTelemetrySnapshot`):

| 字段 | 口径 |
|---|---|
| `acquireCount` / `hits` / `misses` | `misses` = 真实 GPU 分配次数;`misses < acquireCount` 即复用生效 |
| `allocatedBytes` | 真实新分配的估算字节(格式 bytes/pixel × w × h × 采样,未登记格式抛错) |
| `reusedBytes` | 命中复用字节 = 相对无池基线的下降量 |
| `peakResidentBytes` | **含 staging 的驻留峰值** = 空闲 + 挂起回池 + 在途字节和的历史最大值 |
| `freeCount/Bytes`、`inFlightCount/Bytes`、`pendingReturnCount/Bytes` | 三态驻留分解 |
| `discardedCount` / `evictedCount` / `epoch` / `lastInvalidation` | 失效与作废账目 |

后续切片把 renderer 帧路径接上池后,该快照即可挂入 `PbrRendererDiagnostics` 只读暴露;
本切片未动 renderer 帧路径,不存在死接线。

## 6. 验证证据

门禁(全部通过):

```
pnpm --filter @bim-studio/deep-engine exec vitest run src/webgpu/pbrTransientTexturePool.test.ts
  → 9 passed (9)
pnpm --filter @bim-studio/deep-engine typecheck
node packages/deep-engine/scripts/runtimePurityGate.mjs
```

测试用例 ↔ 边界对应(纯逻辑,fake GPUTexture 句柄,不碰真 GPU,夹具沿用 `renderTargets.test.ts`):

1. 同键跨帧复用命中;格式/尺寸/采样/usage 任一不同的异键互不串;
2. history 三资源 acquire 抛错,永不入池;合同外私有 transient 允许入池;
3. resize 全失效重建(epoch+1、evicted 账目、新分配);
4. session lost 拒绝分配 + `lastInvalidation` 记录;
5. 失败提交在途纹理全部销毁、重试取全新纹理;
6. 帧内同键重叠不共享;双重 release 抛错;
7. scope 误用族(begin 未闭、外源 release、漏 release 的 endFrame(true));
8. 5 帧 × 3 目标:acquire 15 次、misses 3 次、`allocatedBytes` = 单帧字节 < 无池基线 5 倍,
   `reusedBytes` = 4 帧节省量,`peakResidentBytes` = 3 纹理字节和(staging 峰值入账);
9. 并发两池完全隔离(invalidate 互不影响、命中各自回池纹理)。

## 7. 边界与未验证项(如实声明)

- **像素与帧时不退化:本切片未验证**——池尚未接入真实 `renderTargets`/`PbrTransparencyPass` scratch
  路径,该验证归真机门禁切片(见任务约束"接入真实 renderTargets 的切换与像素/帧时不退化验证归真机门禁")。
- 本切片**未改动任何真实 encode 的 GPU 提交顺序**;`renderTargets.ts` 保持原样(切片时其 git 状态干净,
  无并行在途修改)。
- 字节估算为格式查表静态估算,不含实现相关对齐/tiling 开销;`peakResidentBytes` 是估算口径的峰值。
- 复用率换安全:帧内重叠同键不共享,首帧后稳态命中数 ≤ 每帧 distinct 键数;池无容量上限
  (纹理由 `DeviceSession` 持有,随 dispose 全量回收),容量预算归接入切片与真机数据一起定。
