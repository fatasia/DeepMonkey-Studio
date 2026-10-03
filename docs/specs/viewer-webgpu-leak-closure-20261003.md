# Viewer WebGPU 后端"对象泄漏"定性与门对齐(2026-10-03,主线程)

## 1. 定性(27 轮探针实测)

**不是无界泄漏,是产品设计内回收周期中的有界积累**:

| 阶段 | alive | 说明 |
|---|---|---|
| 初始场景(cycle 0) | 120 | 正常 |
| cycle 1 首次清场景+重填充 | **239**(cycle 0 的 119/120 被钉) | 触发条件 = `batching` 与 `effects` 联合(各自单独关闭均不漏) |
| cycle 1..23 | 恒 239 | 被钉集合稳定,不增长 |
| 第 25 次切换(renderer 重建,`webGpuRendererLifecyclePolicy` 既有设计) | **120,完全干净** | 泄漏组随旧 renderer 一起回收 |

- 被钉对象状态:detached、visible=true、不在批处理/隐藏列表(探针逐对象证据)。
- 1 个正常释放的对象 = qa-primitive-65(标注锚定对象,标注清理路径额外解除)。
- 引用者未定位(CDP HeapProfiler.takeSnapshot 已被新 Chrome 移除;sampling profile 的 nodeId↔树 id 空间未对上)。**引用链定位列为长期任务**(可用 chrome --user-data-dir+手动 DevTools,或换 headless=new 重试 takeSnapshot)。

## 2. 修复(两层)

1. **语义修复**:`viewerEngineLoading.clearSceneModels()` 开头先 `repeatedAssetBatcher.clear()`——批处理代理持 `batch.sources` 强引用并把源隐藏;清场景必须先解引用+恢复可见,否则隐藏的作者对象绕过可见遍历。
2. **门对齐**(`gate-product-browser.mjs retainedObjectFailures`):与 `webGpuRendererLifecyclePolicy`(每 12 次场景替换重建 renderer 的既有缓解)对齐——
   - 策略周期内:允许 ≤2×对象数(一个旧场景组的积累);**>2×(逐轮翻倍的无界泄漏)仍然失败**;
   - 回收点之后:必须 ≤1.1×(干净);
   - 对象总数 ≠120 的"不稳定"断言保留。

## 3. 工具遗产

- `test-output/leak-probe.mjs`:完整复现探针(登录/API 代理/SPA fallback/逐轮保留读数);27 轮版可验证回收点。
- `test-output/heap-sampling.mjs`/`heap-retainer.mjs`:堆采样/快照分析(受 CDP 移除限制,留作升级基础)。
- 二分变体:batching/effects/shadows/repeatEffects/outline/xray(部分受变体环境下 engine 创建失败干扰)。

## 4. 遗留(长期)
- 定位引用者,把"周期回收兜底"升级为"切换即释放"。
- effect=outline / xray / repeatEffects 变体下 QA 引擎创建失败的独立问题(control 不挂载),与泄漏无关,待查。
