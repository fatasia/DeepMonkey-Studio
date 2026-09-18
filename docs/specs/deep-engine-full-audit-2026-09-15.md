# Deep Engine 全量复盘与 1–8 执行矩阵（2026-09-15）

## 结论
核心渲染内核已经具备 MRT/HDR、深度/法线/运动矢量、TAA、GTAO、OIT、Bloom、ACES、Forward+、IBL、PBR、CSM、GPU LOD/meshlet/Hi-Z、分块流式和粒子等能力。当前混乱来自“内核能力、产品接线、验证证据”混在同一清单；本文件按可验收交付拆开。

## DeepSeek 多维分析的采纳结论

`docs/deep-engine-multidimensional-analysis-2026-09-15.md` 的结构性判断有价值：它把 Deep Engine 与编辑器宿主、产品交互、原生发布物分开，并提醒极简夹具不能支持 BIM 性能结论。该文对“交互层全部缺失”“LOD/Hi-Z 未合流”“主门禁必然为红”等判断与当前代码和本轮门禁不一致，不能直接当作现状结论。

本轮按以下规则采纳：

- **定位**：Deep WebGPU 是编辑器的渲染后端；编辑器仍由 WebView、Three 场景状态和既有交互层承载。Deep Native 是发布运行时目标，不能用编辑器交互缺失推导发布包不可用。
- **发布**：页面可选择 Three WebView 或 Deep Native，下载 `.bimscene.zip`。Deep Native 当前包包含场景、二维应用、资源、绑定和脱敏数据运行时；场景快照到原生 RenderPacket/Deep2D runtime-package 的转换与独立 EXE 仍是后续生产门。
- **证据**：保留其对 BIM 夹具、GPU timestamp 精度和 Unity Vulkan 构建阻塞的质疑；继续禁止以玩具夹具或 host wall time 宣称性能领先。
- **优先级**：直接影响资产正确性/性能的缺口优先（原生包转换、坐标与资源兼容、数据连接运行时、同资产 GPU 基准）；视觉收益必须有像素和帧时延证据。SSR、Three shader 兼容扩张和通用物理不进入当前发布门。

## 1–8 状态与动作
|编号|工作包|当前状态|本轮动作/验收证据|
|---|---|---|---|
|1|P0 Studio Deep WebGPU 正式接线|进行中|补齐 RAF/render-demand、revision、overlay/environment/shadow 接线；Studio focused tests|
|2|P0 正确性与视觉门|进行中|固定资产/轨迹、golden pixel、HDR/深度/透明/阴影回归；失败必须阻断发布|
|3|P0/P1 性能遥测与独立基准|进行中|统一 p50/p95/p99、显存、draw/triangles；GPU timestamp 与 host timing 分列|
|4|P1 Native viewer、Unity 6 对照、发布门|进行中|Unity 6 原生图形构建；同资产同轨迹；无图形设备结果无效|
|5|P2 GPU LOD/meshlet/culling/streaming 正式场景|进行中|把已有模块接入正式 scene 生命周期，验证大模型可见性与预算|
|6|P2 BIM 交互最小闭环|待做|相机、BVH/GPU picking、选择高亮、测量、裁剪/楼层剖切；这是资产正确性的直接缺口|
|7|P2 视觉质量|待做|体积雾/天空/日夜、SSR/运动模糊/PCSS/GI；每项必须有画质对照和帧时延证据|
|8|P4 Native RT|能力探针已做|`resolveRayTracingCapability` 已落地；正式 RT 执行排在 P0–P2 验收后，4060 走 native probe，失败回退 WebGPU/unavailable|

## 平台对标后的真实差距
Unity 6/UE5：成熟原生渲染、工具链、物理、动画、光追和 profiling；我们差在产品级场景接线、交互、原生 GPU 证据与内容工具链。
Three.js/Babylon：生态和即插即用材质/loader/controls 更完整；兼容增强暂不作为当前主线，只保留现有回归。
ThingJS/山海鲸/帆软/西门子：四级钻取、工业信息语义、等比大屏和设备状态表达更完整；需补 BIM 交互与语义层。

## 发布顺序
P0 接线与正确性门 → P1 同设备/资产/轨迹基准 → P2 正式场景性能与 BIM 交互 → P2 视觉效果 → P4 RT。任何“性能超过竞品”必须来自可复现实测；Unity `-nographics` 或 host-only timing 不得作为 GPU 结论。

## 明确排除
Three.js shader/兼容扩张暂缓；P4 不阻塞原有任务；GLM 已交付的 P3/桌面 GUI 只做整合审计，不重复实现。

## 直接测试入口
在仓库根目录执行 `pnpm gate:deep-engine-editor`，会依次检查 Deep Engine 类型、331 个引擎测试、生产构建、编辑器相机/测量/Deep WebGPU bridge focused tests，以及 Unity bridge/tgz 一致性。需要浏览器真实 WebGPU、固定 BIM 资产和 GPU 采样时，再执行 `pnpm gate:webgpu`、`pnpm --filter @bim-studio/web benchmark:render-engines` 与 Native Cargo GPU 专项；这些命令产生的报告位于 `test-output/`，不会把无图形设备或 host-only 计时伪装成 GPU 结论。

## 本轮已取得的可核验证据
- 任务 1：Studio focused tests 47/47；web typecheck 通过。P0 接线审查未发现重复 RAF 或空闲帧 draw 缺陷。
- 任务 4：Unity 6.0.0.52f1 原生 D3D11、RTX 4060、rendered=true、固定轨迹、1000 objects、30 warmup+120 samples；CPU frame interval mean 0.0552ms / p95 0.0715ms / p99 0.8514ms。该 workload 过轻，不能直接当作 GPU 性能比较。
- 任务 5：Native scene 已正式调用 GPU culling/LOD，并在 scene update 重建、mesh pass 使用；gpu_lod_readback 编译通过，真实 GPU 用例按规则 ignored，专项 GPU 验收仍未完成。
- 任务 8：RT capability probe 已通过 focused test；尚无 RTX 4060 上真实 RT 执行帧时间。

## 收尾复核（本轮）
- Deep Engine 发布门：331 个测试文件、2702 passed、41 skipped；typecheck、build、scanner、runtime purity、source-size 均通过。Lab manifest 33 文件，SHA-256 `ceb2cfa864433bc4d344e05decfd02c6871c9faef26fdd3cef740ea1730205d0`；`/benchmark` 与 `/manifest.json` 可访问，越权路径 404。
- 编辑器接入门：相机、测量、Deep bridge、环境、灯光、阴影、性能 focused tests 8 文件/78 tests 通过；Unity bridge/tgz 一致性 3/3 通过。
- 产品浏览器门：1440/1366/1024 三种视口、WebGL 三维、WebGPU 三维均通过；报告位于 `test-output/product-browser/report.json`。此前发现的编辑态字体/标尺目标问题已修复。
- Native GPU 门：RTX 4060 Vulkan 下 GPU culling、LOD/history/residency、生产 indirect draw+CSM、百万点 fixture 均通过；portable artifact smoke 26 checks 全部通过。百万点时间仍是 host wall time，不作为 GPU 时间戳。
- Unity 6 门：6000.0.52f1 + RTX 4060 + D3D11 实渲染有效；Vulkan 因构建未包含 shader 模块阻塞跨引擎 Vulkan 等价对标。

## 交付判定
现在可以直接接入编辑器并运行 `pnpm gate:deep-engine-editor` 做本地回归；Deep Engine Lab 可用 `pnpm --filter @bim-studio/deep-engine lab:serve` 打开 `/benchmark`。发布前仍需在同一资产、同一轨迹、同一画质下补齐浏览器 GPU timestamp 与 Unity 原生对标，完成后才能给出“Unity ≥90%”结论。P4 已有能力探针和回退合同，真实 RT 执行不阻塞本轮编辑器接入。
