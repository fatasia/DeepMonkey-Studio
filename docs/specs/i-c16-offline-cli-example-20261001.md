# I-C16 离线HDR Node例子（2026-10-01）

## 现状核查

1. packages/apps、examples/scripts与未跟踪文件核查：已有Node独立SDK例子和browser PBR例子，无PT CLI/出图消费。当前PT源码已冻结，不改。
2. 契约：复用正式RenderPacket JSON的materializeRuntimeRenderPacket/serializeBrowserRenderPacket、RuntimeSceneCamera和PathTraceCpuRender；不定义新场景协议。
3. 依赖：Node、SDK构建产物与node:test已有，不加依赖。Node例子既有.mjs惯例。
4. 消费方：public SDK有PT工厂/消费者；JSON materializer是dist内部模块，非公开SDK API。CLI仅本仓examples使用相对内部模块，不伪称外部稳定API。
5. 证据：PT核27测、正式适配19测、RT/HDR/camera421通过；无Node异步SIGINT/噪声拒绝/实际文件输出回归。
6. 规格：已读remaining、T10与前两片报告、GLM handoff；产品UI、完整材质纹理仍后继，不因CLI例子关闭整项。

### 已有（不重建）

正式JSON重建、静态实例适配、共用PT transport、异步累积/取消、逐像素噪声门、HDR编解码和hash。

### 真实缺口

薄Node消费入口、分批调度SIGINT、噪声不足不写final、标识preview、非空多实例合法样本与CPU文件/数值证据。

## 实施

仅新增examples/offline-path-trace.mjs、样本/verify薄例子与Node CLI消费测试、examples文档。输入两个既有JSON（RenderPacket与RuntimeSceneCamera）；参数控制resolution/seed/spp/batch/noise。SIGINT链接AbortSignal；每spp通过setImmediate交还事件循环。未收敛exit2且不写最终HDR；显式--preview只写`.preview.hdr`并给preview receipt。

输出文件用排他创建，失败/取消不覆盖已有产物。回执记录input SHA256、seed/spp/逐像素RSE、实际HDR hash与RGBE roundtrip误差。fixture为本地自建解析三角场景，无外来样本授权需求。

## 验证

已执行：

- `node --test examples/offline-path-trace.test.mjs`：6/6通过，真实构建SDK Node进程消费（合法出图、1 spp噪声拒final、preview-only文件、SIGINT→AbortSignal取消/驻留归零、unsupported介质原样拒绝、已有文件保护），无源码旁路/无mock积分。
- Windows子进程的kill(SIGINT)直接终止而不会进入JS signal hook；测试在该子进程经stdin派发Node实际SIGINT事件钩子，随后未修改的CLI创建/取消AbortController。已验证该事件→异步样本取消链，未测物理终端Ctrl+C。
- 三个.mjs均通过node --check。修改仅examples与独立文档，SDK生产源/index保持冻结。
- CPU保留场景为本地自建双面平面：2个静态实例（Lambert IOR1 + GGX metallic1/roughness1），共用1个BLAS；输入使用正式serializeBrowserRenderPacket JSON和RuntimeSceneCamera。
- 64×32、1024 spp、seed17、常量白环境[1,1,1]：最终逐像素max RSE=0.039995005239863456 ≤0.05；HDR已出图，状态final/converged=true。
- 独立解析：280个Lambert内点目标[0.7,0.5,0.2]，RMSE=0.0006378879538497721 <0.004；280个GGX内点用独立Smith闭式 `1−nv*ln((1+nv)/nv)`，RMSE=0.010606650284938436 <0.03。GGX参考用像素中心视角，AA足迹与MC误差包含在门内。
- RGBE encode→decode往返最大绝对误差=0.0019530653953552246，最大线性值1，符合≤max/128。
- 两次同输入/seed出图HDR SHA-256完全相同：`865caa85bdbe66230332bc3832cab33cb232c341f859db26443285d1c9f82223`。

证据目录：`test-output/i-c16-offline-cli-20261001/`。最终产物 `final64x32.hdr` 与 `.receipt.json`；独立数值 `final-independent-reference.json`，原始6测 `node-tests.txt`，128个异步批次进度 `final-progress.jsonl`；scene.json/camera.json保留正式输入。

## 入口

在packages/deep-engine执行 `node examples/offline-path-trace.mjs --help`，完整使用与自建fixture命令见[薄例子说明](../../packages/deep-engine/examples/offline-path-trace.md)。最终engine build由主线完成后本片消费其SDK输出；复核可直接 `node examples/offline-path-trace-fixture.mjs verify ../../test-output/i-c16-offline-cli-20261001/final64x32.hdr`。

例子入口已冻结，无GPU/Cargo/commit操作。它提供可运行CPU离线出图子集，未替代作者UI、完整材质/纹理、MIS/降噪、GPU验收或I-C16/T10整项。
