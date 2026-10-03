# 路径追踪出图并行化与高质量出图（2026-10-03）

目标：把编辑器「物理光照出图」（CPU 参考内核）升级为可用于高质量出图的水平——多 Worker 并行、可到 1080p、可导出 sRGB PNG。对标 Blender Cycles 预览 / Unity Progressive Lightmapper 的使用体验（可停止并保留、实时合并进度、预估耗时、内存保护）。

## 现状核查（动手前）

**已有（不重建）**

| 能力 | 位置 |
|---|---|
| 作者源 → packet/camera 编译，fail-closed 的不支持项 | `delivery/pathTraceAuthorPreparation.ts` |
| CPU 内核（逐像素 `traceSample(x,y,ordinal,seed)`，RNG 仅由 `(seed,x,y,ordinal)` 决定，无跨像素状态） | `deep-engine/src/rayTracing/pathTraceCpuTransport.ts`、`pathTraceRenderPacketKernel.ts` |
| 累积/噪声门/取消/收据状态机、逐像素 Welford 均值/M2、Radiance HDR 编码 | `pathTraceSession.ts`、`pathTraceCpuRender.ts`、`pathTraceSessionTypes.ts` |
| 单 Worker 会话、对话框、顶栏入口（导出场景菜单）、HDR + json 回执 | `delivery/pathTraceAuthorSession.ts`、`PathTraceAuthorDialog.tsx`、`SceneExportMenu.tsx` |
| 显示合约 tone mapping（`DEFAULT_DISPLAY_CONTRACT.toneMapping.operator`）预览转换 | `delivery/pathTraceAuthorPreview.ts` |
| `browserDownload.downloadBlob/downloadTextFile`、sha256（`crypto.subtle`） | `browserDownload.ts` |
| 站点 `crossOriginIsolated`：**否**（Vite 无 COOP/COEP 头，实测 `false`） | 实测 |

**真实缺口**

1. 仅单 Worker；`PathTraceCpuRender.advance` 总是遍历整幅图，没有行子集入口。
2. 分辨率只有 160/320/640，无预估耗时/内存预算保护，累积预算写死 64 MiB。
3. 只有 HDR + json，没有 sRGB PNG；没有「停止并保留」。
4. 无并行时的确定性/等 spp 约束、取消时全体 Worker 的立即终止契约。

`omission-audit-20261004.md` #7 的 I-C16 后继（纹理/单面/alpha/扩展层/HDR 环境/局部光 IES、硬件 RT/降噪）是**内核能力**扩展，不在本任务范围，保持登记。

## 设计

- **数学不变**：像素 (x,y) 的第 n 个样本只依赖 `(seed,x,y,n)`，所以任意行划分下每个像素的 Welford 序列与单线程逐位相同。新增 `PathTraceCpuBand`（`pathTraceCpuBand.ts`）只是 `PathTraceCpuRender.advance(1)` 的行子集孪生，不改既有类。
- **分块**：`partitionPathTraceRows(height, N, stripeRows=4)` 以 4 行条带轮转分配给 N 个 band（天空行便宜、几何行贵，轮转比连续分块负载均衡）。N=1 退化为单个区间 `[0,H)`，像素遍历顺序与原来完全一致。
- **同步**：协调器（主线程，`pathTraceAuthorParallel.ts`）按样本序号锁步：每轮每个 band 各推进 1 spp，回报「本 band 的整帧亮度份额 + 本 band 的逐像素最大相对标准误」。协调器按 band 顺序求和喂给既有 `PathTraceProductSession.advanceBatch`（样本门/帧方差门），再取各 band 噪声最大值做逐像素噪声门。因此各 band spp 恒等，收敛判定与单线程一致（样本序号级）。
- **取消**：`cancel()` 对所有 Worker `terminate()`（即使正在样本中途），拒绝全部 pending，释放 lease；`AbortSignal`、场景失效、Worker 报错都走同一条路径。
- **packet 传输**：N 个 Worker 各自收到一份 structured-clone 的 prepared packet（各自建 BVH/内核）。站点不是 cross-origin isolated，**不要求 COOP/COEP，直接拷贝**；回执记录 `transport:"structured-clone"` 与 `crossOriginIsolated`。内存预算按 `N×(3×packet+16MiB)` 计入。
- **确定性**：同 seed + 同 N 逐字节可复现（测试覆盖）；因像素独立，图像在不同 N 之间也逐位一致（测试 N=2/3/5 与 N=1 的 HDR 字节、spp、噪声全等）。回执 `parallel` 记录 `workers/stripeRows/bandRows/seed/transport/crossOriginIsolated`。
- **进度合并**：每 ≥250 ms（且 ≥ 6× 上次预览转换耗时，防止 tone mapping 吃掉算力）让各 Worker 回传自己行的 sRGB RGBA，主线程按条带拼成整帧；状态栏显示合并 spp / 噪声 / spp·s⁻¹ / 线程数 / 已用时 / 最长剩余。
- **分辨率档**：160/320/640/1280/1920（1080p），16:9。预估耗时 = `像素×spp / (吞吐×线程)`，吞吐默认为经验值，一旦完成过渲染就使用本机实测值；内存预算 = `deviceMemory/4`（夹在 384 MiB–2 GiB），先降线程数再禁用档位，仅在 1 线程仍超预算时禁用并用 tooltip 说明（对话框不崩溃，开始前/编译后各校验一次）。
- **PNG**：Worker 端用与预览相同的 `encodePbrDisplayColor`（算子取自 `DEFAULT_DISPLAY_CONTRACT.toneMapping.operator`，曝光 `PATH_TRACE_DISPLAY_EXPOSURE=1`，与预览/历史行为一致）转 sRGB RGBA；主线程以 Canvas（`OffscreenCanvas.convertToBlob`，回退 `toBlob`）编码，并插入标准 `sRGB` 块；sha256 写入 `*-png.json` 回执，`downloadBlob` 下载。
- **停止并保留**：累积中随时结束于当前样本，得到可导出（预览标签）的部分结果。

## 改动文件

- `packages/deep-engine/src/rayTracing/pathTraceCpuBand.ts`（新）+ `pathTraceCpuBand.test.ts`（新）、`src/index.ts`（导出）
- `apps/web/src/delivery/`：`pathTraceAuthorParallel.ts`（新，协调器）、`pathTraceAuthorBandHost.ts`（新，Worker 侧 band 宿主）、`pathTraceAuthorBudget.ts`（新）、`pathTraceAuthorPng.ts`（新）、`pathTraceAuthorWorker.ts`/`pathTraceAuthorWorkerTypes.ts`（改：band 协议）、`pathTraceAuthorSession.ts`（抽出共享 `createPathTraceAuthorKernel`/`pathTraceAuthorReceipt`，单进程会话保留为 N=1 真值基准）、`pathTraceAuthorPreview.ts`（导出曝光常量）
- `apps/web/src/components/`：`PathTraceAuthorDialog.tsx`（重写）、`PathTraceResolutionPicker.tsx`（新）、`PathTraceStatusBar.tsx`（新）、`PathTraceAuthorDialog.css`、`SceneExportMenu.tsx`（副标题文案）
- 测试：`pathTraceAuthorParallel.test.ts`、`pathTraceAuthorBudget.test.ts`、`pathTraceAuthorPng.test.ts`、`PathTraceAuthorDialog.test.tsx`（重写）

## 实施结果

### 校验

- `packages/deep-engine`：`npx vitest run src/rayTracing` 39 文件 / 337 通过（含新增 `pathTraceCpuBand.test.ts` 8 项：1 band 与 `PathTraceCpuRender` 像素/噪声逐位相等；2/3/4/8 band 与全帧逐位相等；行分区覆盖）。`tsc --noEmit` 对 `rayTracing/` 无错（该包仅有他人在途文件 `shader/materialAdvancedReference.ts` 的 2 个既有报错）。
- `apps/web`：`npx tsc --noEmit -p .` 对本任务文件无错；`vitest run src/delivery/pathTrace* src/components/PathTrace*` 5 文件 / 31 通过：
  - **N=1 逐字节等同现状**：`pathTraceAuthorParallel.test.ts` 用真实编译器场景、真实 band 宿主（经 structuredClone 边界），N=1 的 HDR 字节、spp、噪声、回执（除 `parallel` 字段）与单进程 `PathTraceAuthorSession` 完全相等；N=2/3/5 的 HDR 字节与 spp 也与 N=1 相等；同 seed 同 N 可复现，换 seed 不同；各 band 步数恒等。
  - 取消（API 取消、`AbortSignal`、Worker 报错、场景失效）均终止全部 Worker 并释放 lease；预览/最终导出标签；超预算在建 Worker 之前拒绝。
  - `PathTraceAuthorDialog.test.tsx`：3 线程真实并行渲染 → 停止并保留 → HDR 预览与 PNG 导出（PNG 像素与导出 HDR 的 tone mapping 误差 ≤3/255，`sRGB` 块、sha256 回执）；取消、场景修改失效；分辨率档禁用 + tooltip。
  - `pathTraceAuthorBudget.test.ts`、`pathTraceAuthorPng.test.ts`（sRGB 块 CRC=`AECE1CE9`）。

### 浏览器实测（Chrome 无头，24 逻辑核，`crossOriginIsolated=false`，共享机器有其他会话并发负载）

方法：同源页面里直接 `import` 真实 `preparePathTraceAuthor` + `PathTraceParallelRender`，Worker 使用 esbuild 打出的生产形态单文件 bundle（**245 KB** minified）；场景＝底座/立柱/球三基础体（双面材质）、物理光照、320×180、32 spp、seed 19，噪声门关闭以固定样本数。

| 线程 N | spp/s（范围，多次） | 相对 N=1 | 并行效率（样本计算时间 / N×轮墙钟） | 导出 HDR sha256(前16) |
|---|---|---|---|---|
| 1 | 2.05–3.07 | 1.0× | 0.955 | `5f0880f91d23052c` |
| 2 | 4.02–5.62 | ≈1.6–2.0× | 0.945–0.956 | `5f0880f91d23052c` |
| 4 | 5.96–8.42 | ≈2.4–2.9× | 0.91–0.93 | `5f0880f91d23052c` |
| 8 | 8.21–13.89 | **≈3.2–6.8×（同一轮内相邻 N=1/N=8 对：2.05→13.89 与 2.54→8.21；中位≈4.5×）** | 0.79–0.90 | `5f0880f91d23052c` |
| 12 | 15.11–17.65 | ≈5–6× | 0.84 | `5f0880f91d23052c` |
| 16 | 14.88 | ≈5× | 0.73 | `5f0880f91d23052c` |

读数说明：① N 变化时导出 HDR 字节完全一致（浏览器内再次证明确定性与分块无关）；② 单样本 CPU 时间随 N 增大而膨胀（12 s→25 s 总计算），主因是共享机器负载 + SMT/内存带宽，协调开销（锁步/合并/预览）只占 5–20%；③ 单次测量抖动大（N=1 在 2.0–3.1 间），故给范围。自动线程数＝`min(8, hardwareConcurrency−1)`，本机为 8。
- 对话框内 8 线程自动模式实测：320×180 ≈ 10.8 spp/s；1280×720 ≈ 0.36 spp/s；1920×1080 ≈ 0.23–0.34 spp/s（0.23 spp/s 即约 4.3 s/样本）；1080p 导出 PNG 3.38 MB，签名/`sRGB` 块/IHDR 校验通过，回执 `pngSha256` 与文件 SHA-256 一致。
- 截图（深色 1920×1080，位于会话 files）：`pt-ui-1920.png`（1080p 档，预估/内存提示）、`pt-1920-idle-live.png`（8 线程累积中，合并进度）、`pt-1280-done.png`（停止并保留后）、`pt-loading.png`（启动骨架）、`pt-cancelled.png`（取消后内存已释放）。

### 开发中发现的非本任务问题（已记录，未改）

1. **开发服务器下 8 个 module Worker 同时加载未打包依赖会触发 `ERR_INSUFFICIENT_RESOURCES`**（每个 Worker 经 Vite 逐模块请求 deep-engine 依赖图），表现为 Worker `error` 事件无 message。生产构建把 Worker 打成单文件（245 KB），不受影响；本次浏览器实测改用生产形态 bundle。协调器会把它报为「出图线程异常终止」并整体清理，不崩溃。
2. **编辑器当前保存的材质默认带 `clearcoat/sheen/…` 等物理 lobe 中性字段，而 `sceneSnapshotRenderPacket` 对其抛「材质需要适配：clearcoat」**——这是他人在途的 physical-lobe 工作（`scenePhysicalLobeProjection.ts`、`sceneMaterialOverrides.ts`、`compileSceneRenderPacket.ts` 的未提交改动）造成，导致编辑器内任意带这些字段的场景暂时无法物理出图。本任务的编辑器内 E2E 因此改为同源页面直连真实编译器/协调器/对话框组件实测（对话框用同一份 `PathTraceAuthorDialog` 与 `base.css` 令牌挂载）。该问题需由 lobe 工作方在静态包路径中处理中性值。
3. 既有限制仍在：单面材质（`unsupported single-sided surface`）、局部光/IES、外部 HDR、纹理等仍 fail-closed（`omission-audit-20261004.md` #7）。编辑器默认示例底座是单面，需在材质里打开「双面」才可出图。

### 遗留

- 逐像素噪声门在带几何的场景里很难达到 2%（边缘像素重尾），多数 1080p 出图会停在「样本上限/停止并保留」——属内核统计特性，未改阈值语义。
- 吞吐预估在首次完成渲染前用经验默认值（90k px·spp/s/线程），之后用本机实测值；未做渲染前的快速标定。
- 没有 tile 级重分配（条带轮转已使负载均衡到 ~0.9 效率，未做动态窃取）；packet 每 Worker 一份拷贝（非 COOP/COEP 站点，无 SharedArrayBuffer）。若将来启用 cross-origin isolation，可把 packet 与累积面改为共享内存以降低 N× 内存。
- 对话框内 `ptBenchMount` 之类临时挂载文件已删除；性能脚本留在会话 files（`pt-bench2.mjs`、`pt-dialog.mjs`、`pt-worker.mjs`）。

## 收尾与交接（2026-10-03 阶段 1 结束，交 GLM）

**稳定性确认（17:40）**：`apps/web` tsc 对本任务文件无错；`vitest run src/delivery/pathTrace* src/components/PathTrace*` 5 文件/31 通过；`deep-engine` `vitest run src/rayTracing` 39 文件/337 通过；Worker 入口 `pathTraceAuthorWorker.ts` 可被 esbuild 打成 245 KB 单文件。无半成品、无临时文件（`ptBenchMount.tsx` 已删）。未提交（按要求）；注意其它会话已把部分本任务文件一并提交，工作树里它们显示为已跟踪。

### 已完成
目标 1–6 全部完成：多 Worker 分块并行（N=1 与旧会话逐字节一致）、1280/1920 档 + 预估耗时 + 内存预算、sRGB PNG + sha256 回执、「停止并保留」、对话框 UI、测试与浏览器实测（见上节）。

### 未完成 / 未验证
1. **编辑器内（真实编辑器场景 → 顶栏导出菜单 → 对话框）的 E2E 没跑通**：被他人在途 physical-lobe 改动挡住（`sceneSnapshotRenderPacket.ts:49` 对 `clearcoat:0` 等中性 lobe 字段抛「材质需要适配」）。我用同源页面挂载真实 `PathTraceAuthorDialog` 做了替代实测。
2. 渲染前吞吐标定缺失（预估首次用经验值 90k px·spp/s/线程，见 `pathTraceAuthorBudget.ts` `DEFAULT_PIXEL_SAMPLES_PER_SECOND`）。
3. 无动态 tile 窃取；packet 每 Worker 一份拷贝。

### 已知风险
- 开发服务器下 ≥8 个 module Worker 并发加载未打包依赖会 `ERR_INSUFFICIENT_RESOURCES`（仅 dev；生产单文件不受影响）。
- `PathTraceAuthorDialog.test.tsx` 用 `useState/useRef` 位置式 mock 驱动函数组件：新增/调整 hook 顺序会使测试错位。
- 对话框内存预算基于 `navigator.deviceMemory`（Chrome 上限 8）→ 预算上限 2 GiB；Safari/Firefox 无该字段时按 4 GB 估算。
- 带几何场景的逐像素 2% 噪声门几乎不可达，用户通常靠「停止并保留」。

### 下一步精确动作（按优先级）
1. 待 physical-lobe 工作落地后，在编辑器里复测：`更多 → 导出场景 → 物理光照出图`（材质需「双面」）。若仍抛 clearcoat：在 `delivery/sceneNeutralAppearance.ts` `isNeutralMaterialField` 增加 lobe 中性值（`clearcoat/sheen/iridescence/transmission/thickness`=0 等）或由 lobe 方在 `sceneSnapshotRenderPacket.ts:49` 处理；不要在 `pathTraceAuthorPreparation.ts` 里绕过。
2. 可选：在 `PathTraceAuthorDialog.tsx` `start()` 里，Worker 在 `init` 阶段失败且 `workers>1` 时自动以 `ceil(workers/2)` 重试一次（`PathTraceParallelRender` 构造/`run` 已能整体清理）。
3. 可选：首次渲染前跑 1 个 64×36 小样本标定吞吐，调用 `recordPathTraceThroughput`。
4. 可选：若站点后续启用 COOP/COEP，把 `pathTraceAuthorParallel.ts` 的 packet 传输改 SharedArrayBuffer（回执 `parallel.transport` 已预留）。

### 复现/验证命令
- `cd apps/web && npx tsc --noEmit -p . && npx vitest run src/delivery/pathTrace src/components/PathTrace`
- `cd packages/deep-engine && npx vitest run src/rayTracing`
- 性能脚本（会话 files）：`pt-bench2.mjs`（N 对比，需 `pt-worker.mjs` = `npx esbuild src/delivery/pathTraceAuthorWorker.ts --bundle --format=esm --platform=browser --minify --outfile=…`）、`pt-dialog.mjs`（需临时挂载文件 `src/ptBenchMount.tsx`，已删，如需复现按文档设计重建）。