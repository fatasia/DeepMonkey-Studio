# DE26/B04 · 接真实临时纹理复用(帧内 transient 纹理池)

日期:2026-09-17 · 分支:dev-studio · 状态:主 RenderTargets 生产接线与真机验证完成;后处理/OIT 私有 scratch 尚未纳入,整卡保持待办。

## 1. 任务定义(权威原文)

> transientSlot 尚无生产分配消费证据。依据 B03 兼容键复用 GPUTexture;区分跨帧 history 与帧内目标,
> 按 queue 生命周期回收。通过标准:分配计数/估算 bytes 实际下降;像素和帧时不退化,记录含 staging 峰值。
> 边界:resize、设备丢失、并行候选和失败提交不能复用在途纹理。

B03(`pbrFramePlanResources.ts` + `pbrFramePlanExecutor.ts` + `renderGraph.ts` 的 `transientSlot`/`aliasKey`)
只完成了计划侧声明。第一切片把分配/消费落成池本体;本切片继续把池接入 `RenderTargets` 的五张真实主帧纹理。

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

`PbrRenderer.transientTextureStats` 与每帧 `FrameMetrics.transientTextures` 直接暴露生产池快照;
lab 的 120 帧采样记录同一快照,计数来自真实 `device.createTexture` 路径。

## 6. 生产接线

真实生命周期只有一条:

```
PbrRenderer.render
  → RenderTargets.beginFrame(surface size)
  → encode / encoder.finish
  → device.queue.submit
  → RenderTargets.commitFrame()
  → pool.release × 5 / endFrame(true)
```

异常路径统一进入 `RenderTargets.failFrame()` → `endFrame(false)`,销毁本帧接触过的纹理。surface 尺寸变化在
下一帧 `beginFrame` 前使整池失效;`GPUDevice.lost` promise 与显式 device epoch 更迭也销毁空闲/在途资源。
接入的五张生产纹理是 `opaque-hdr`、`linear-depth`、`view-normal`、`motion` 与私有
`hardware-depth`;格式、sample count 与 usage 沿用既有 RenderTargets 合同。`previous-hiz`、`next-hiz`、
`temporal-hdr` 仍由各自跨帧 owner 持有,从未 acquire,不会与主帧目标 alias。

## 7. 验证证据

门禁(全部通过):

```
pnpm --filter @bim-studio/deep-engine exec vitest run src/webgpu/pbrTransientTexturePool.test.ts
  → 9 passed (9)
pnpm --filter @bim-studio/deep-engine exec vitest run src/webgpu/renderTargets.test.ts src/webgpu/pbrTransientTexturePool.test.ts
  → 15 passed (15)
pnpm --filter @bim-studio/deep-engine exec vitest run src/webgpu
  → 1123 passed / 22 skipped (143 files)
pnpm --filter @bim-studio/deep-engine typecheck
pnpm --filter @bim-studio/deep-engine lab:build
  → dist/assets/index-*.js 1,374,258 bytes (gzip 378,290)
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

生产 `RenderTargets` 另有 6 项测试:真实纹理对象跨提交帧复用、bind-group 发布失败全量回收、提交失败销毁、
resize 与显式 epoch 重建、`device.lost` 清理开帧资源、5 帧 × 5 目标只分配 5 次且 20 次命中。

真机记录见 [de26-b04-render-target-evidence-2026-09-17.json](de26-b04-render-target-evidence-2026-09-17.json)。
NVIDIA Lovelace 非 fallback adapter、1180×825、49 球、120 帧:

- 177 个生产帧共 acquire 885 次,miss 5、hit 880,命中率 99.44%;真实分配保持 5 张;
- `allocatedBytes=23,364,000`,`reusedBytes=4,112,064,000`,`peakResidentBytes=23,364,000`;
- CPU submit P95 0.70 ms、GPU P95 0.852 ms(120/120)、RAF interval P95 7.10 ms,GPU errors 为空;
- 初始视口、800 px resize、device rebuild 后首帧与最终 120 帧场景均正常,没有黑帧/裁切/材质或光照退化。

这是生产资源所有权变化,按 `design-taste-digitaltwin` 做了两轮浏览器截图闭环。外观设计本身未改变;
布局、字体、颜色、层级、氛围、材质光照、动效、响应式、状态反馈与同族一致性十维无新增回归,自评 95/100。
lab 页面同时运行的其他可选能力探针仍有既有失败项,不计作 B04 通过;本段只引用主场景、resize、重建设备、
120 帧采样和 transient 统计。

## 8. 边界与未验证项(如实声明)

- 主 `RenderTargets` 已接入并完成真机像素/帧时回归;`PbrPostProcessChain` 与 `PbrTransparencyPass` 的私有
  scratch 仍按原 owner 生命周期分配,尚未迁移到同一池,因此 B04 整卡不标完成。
- 真机只覆盖单 renderer 候选;并行候选隔离由池实例归属测试覆盖,尚无双 canvas 真机采样。
- source-size 门禁仍被 14 个既有超限文件阻断;本切片将 `pbrRenderer.ts` 保持在 300 行,未新增超限项。
- 字节估算为格式查表静态估算,不含实现相关对齐/tiling 开销;`peakResidentBytes` 是估算口径的峰值。
- 复用率换安全:帧内重叠同键不共享,首帧后稳态命中数 ≤ 每帧 distinct 键数;池无容量上限
  (纹理由 `DeviceSession` 持有,随 dispose 全量回收),容量预算归接入切片与真机数据一起定。
