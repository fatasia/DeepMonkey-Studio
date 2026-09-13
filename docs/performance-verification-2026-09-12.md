# 性能项验收:大对象树虚拟化 / 遮挡剔除 / OffscreenCanvas(2026-09-12)

> 对应总账 2026-09-09 用户增量:普通拾取 BVH、大对象树按需渲染、优化器连续图层缓存、遮挡剔除与
> OffscreenCanvas 同时实施;本报告覆盖前三者既有证据之外的两个证据缺口,并记录 OffscreenCanvas
> 从"空开关"到"真实能力"的根因面修复。BVH 拾取与图层缓存此前已验收
> (见 `docs/ordinary-picking-bvh-verification-2026-09-09.md`、`docs/optimizer-layer-cache-verification-2026-09-09.md`、
> `docs/viewer-demand-and-signals-verification-2026-09-09.md`),不重复计数。

## 0. 结论速览

| 特性 | 实现状态 | 浏览器实测 | 关键数字 |
|---|---|---|---|
| 大对象树虚拟化 | 已实现(自研窗口化) | ✅ 10000 行仅挂载 19 行 | 全量 10000 行 → 窗口化 19 行挂载,DOM 元素减少 99.8% |
| 遮挡剔除 | 已实现(保守投影剔除) | ✅ 开/关/恢复三路径 | 600 对象夹具:剔除 511 网格、省 62.1 万三角形、draw calls 降 84%,画面 SSIM 0.9981 |
| OffscreenCanvas | **本轮真实接线**(此前空开关) | ✅ 激活/漂移重启/回退/WebGPU 回退 | worker 240 draws、主线程 drawCalls=0、主线程帧工作量 473ms→55ms |
| 按需渲染 | 已实现 | 此前已验 | `viewer-demand-and-signals-verification-2026-09-09.md` |
| 拾取 BVH / 图层缓存 | 已实现 | 此前已验 | 见上文两份报告 |

证据产物:`test-output/perf-evidence-2026-09-12/<run>/`(report.json + 全部截图/diff 图)。
复现:`cd apps/web && npm_execpath=<pnpm.cjs> node scripts/gate-performance-evidence.mjs`。

## 1. 大对象树虚拟化

实现:`WindowedSceneRows.tsx`(>200 行且开关开启时窗口化)+ `virtualSceneRows.ts`(二分定位 + 160px overscan)
+ `sceneTreePreference.ts`(localStorage,默认开)。设置入口:品牌/设置 → 性能 → "大型目录按需显示"。

实测(QA 页 `?__visualQa=object-tree`,真实组件 + 真实浏览器 + 合成目录数据,不依赖后端):
- 10000 行窗口化:仅挂载 19 行(含 overscan 与 keepMounted),对比全量 10000 行 DOM 元素减少 99.8%。
- 末行可达性:"选中末行" reveal 校正后,末行 `device-9999` 真实选中、容器滚动到尾部、挂载数仍受限(15 行)。
- 对照组:关闭窗口化后 10000 行全部挂载,证明差异来自窗口化机制本身。
- 既有 SSR 基线:`sceneTreeRendering.benchmark.test.tsx`(1000/10000 行仅 24 行挂载)。

## 2. 遮挡剔除

实现:`conservativeOcclusion.ts`(实体墙投影 + 候选网格完全遮挡判定,上限 512 目标/16 blocker)
+ `occlusionDrawFilter.ts`(WebGL renderBufferDirect / WebGPU setRenderObjectFunction 钩子)。
设置入口:性能 → "遮挡剔除"(默认关);动态/剖切场景自动 bypass(`viewerEngineRuntime.ts` update 第三参)。

实测(`?fixture=occlusion&objects=600&batching=off`,webgl):
- 开启:剔除 511/601 个网格、避免 621,376 个三角形绘制、draw calls 下降 84.0%(关闭合批后测得;合批开启时收益体现在
  avoidedTriangles 而非 draw calls,该交互已实测确认并记录)。
- 关闭:运行时切换回原渲染路径,draw calls 恢复。
- 正确性:开/关两张画布截图 SSIM 0.998、MAE 0.0002(遮挡行为无可见破洞)。diff 图:`occlusion-diff.png`。
- 单元:`conservativeOcclusion.test.ts`(7)+ `occlusionProjection.test.ts`(5),含 WebGPU/WebGL 钩子恢复与阴影相机不跳过。

## 3. OffscreenCanvas 后台线程渲染

### 3.1 现状与本轮修复
发现:worker 渲染模块(`offscreenScene.worker.ts` 等 6 个文件)已存在但**引擎从未接线**,
设置页"后台线程渲染"是空开关——直接违反用户"不授权以空开关代替实际能力"的约束。本轮根因面接线:

- `offscreenRenderProtocol.ts`:响应增加 ready/位图回传;`offscreenEnvironmentSupported()` 能力检测。
- `offscreenScene.worker.ts`:渲染后 `transferToImageBitmap()` 回传位图;错误分类(scene-stale 可静默重启 / 其他透传可读原因)。
- `viewerOffscreenController.ts`(新):能力与场景体检 → 快照 → worker 生命周期 → 位图覆盖画布;结构漂移防抖重检
  (800ms)、漂移静默重启预算(2 次/20s,超限如实回退);材质按需采样(版本变化 + 90 帧兜底),避免逐帧全量 toJSON。
- 引擎集成:`ViewerEngineCore.setOffscreenRenderingEnabled`(绑定从可选改必选)、Runtime 渲染分支、Lifecycle 释放。
- 标注/告警 Sprite 属易变叠加层(画布纹理运行时重建):**不进 Worker 快照与签名**,由主线程按投影位置补绘在位图之上
  ——同时修掉两个真实崩溃:快照函数"先 await 后序列化"导致序列化了体检后新增对象(调整为先同步序列化再建纹理位图),
  以及 three `ObjectLoader.parseTextures` 对缺失图像抛 `undefined.data`(快照解析前做纹理/图像合同校验,给出可操作原因)。
- 设置页:开关下方展示真实运行状态与回退原因(`subscribeOffscreenGlobalStatus`)。

### 3.2 浏览器实测
- 激活:`?offscreen=on` → mode=active、frames 持续增长、覆盖画布尺寸正确、**主线程 renderer drawCalls=0**
  (worker 侧 lastDrawCalls=240、lastTriangles≈14.4 万);主线程帧工作量(cpuFrameWorkMs)473ms→55ms。
- 结构漂移:切换场景 → 防抖重检 → 静默重启,mode 保持 active、restarts≥1、帧继续增长。
- 关闭:worker 终止、主线程恢复绘制(drawCalls>0)。
- 画面保真:主/worker 画布截图 SSIM 0.959、严重差异像素 1.49%。差异成因:OffscreenCanvas WebGL 在 headless
  下 MSAA 不可用(边缘锯齿路径不同)与网格纹理 mipmap 差异;几何与构图一致(diff 图 `offscreen-diff.png`,
  内容无错位/丢失)。同类"同场景双路径"对比中遮挡用例 SSIM 0.998,证明比较方法本身可靠。
- WebGPU 回退:`renderer=webgpu` + 开关开启 → 如实回退主线程,原因"后台渲染当前仅支持 WebGL 渲染器",绘制恢复。
- 单元:`viewerOffscreenController.test.ts` 9 用例(环境缺失/场景不兼容/激活发帧/材质按需采样/漂移重启/
  预算耗尽回退/线程错误回退/关闭清理/dispose 幂等)。

## 4. 同族排查记录
- 空开关同族:全局 grep `setOffscreenRenderingEnabled?.` 确认唯一绑定链(binding→engine→controller)已闭环;
  其余四个性能开关(按需渲染/合批/拾取加速/遮挡)均已验证非空。
- 快照竞态同族:`launchWorker`/`scheduleRestart` 两条启动路径共用同一 `snapshotOffscreenScene`,排序修复同时生效;
  解析校验在 worker 端兜底(纹理/图像一一对应),两处校验互补。
- 叠加层同族:Sprite 剔除覆盖标注与运行告警(effectHelper)两类;模型特效 helper(扫描面等)非 Sprite,不受影响。

## 5. 诚实边界
- SSIM 0.959 的保真差异为 AA/mipmap 实现差异,已目检 diff 图确认无几何错位;未做逐像素等价声明。
- WebGPU 后台渲染(Worker 内 WebGPU)不在本轮范围,回退路径已验证。
- CPU 任务时长对比(Tracing 主线程任务数)未纳入断言,仅记录 renderDemand 帧工作量对比;整机 FPS 数据不做声明。
- 门禁为生产 QA 构建、本地 headless Chrome、合成夹具;非 1080p 真机长跑。
