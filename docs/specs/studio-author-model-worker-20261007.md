# Deep 作者模型解析 Worker

把复杂场景冷切换剩余约 214ms 的 GLTF CPU 任务移出作者主线程，保留相同模型、贴图、形变与错误合同。

## 现状核查

1. 已检索 apps/packages 源码及未跟踪文件：compileSceneRenderPacket 逐唯一 asset 规范化后调用唯一 decodeDeformablePacketGlb，作者 hook 当前在 useAppRuntimeEffects.deepBridges；candidate 只消费 authorRenderPacket，不直接编译。已有完整 WASM compiler Worker 与图片 Worker 不重建。
2. 合同已有 DeformablePacketOptions/DeformablePacketGlb、RenderPacket typed arrays、GltfImportError code/path/feature；SceneSnapshot 作者状态不变。只给 Web 编译选项增加可选资产解码 hook，不改 Deep SDK 公共 ABI。
3. 已有固定 glTF Transform 4.4.2、Draco、Meshopt、Worker、OffscreenCanvas；规范化复用 normalizeStudioWasmModel 的 WebIO 路径，不新增 decoder 或依赖。
4. 编译消费包括作者 Deep、Runtime Package、PathTrace、探针烘焙和 API/Node。只有 Deep 作者浏览器 hook 显式启用资产 Worker，默认与 custom imageDecoder/normalizeModel 的消费保持原路径。
5. 既有静态/纹理/skin/morph 编译与取消测试、原 decoded packet 证据均已有。新增输入所有权、输出 buffer 转移去重、错误重构、取消与主线程/Worker 原包逐字节对拍。
6. 已读本轮 image-worker、engine-lod-switch、1336 handoff 与 recovery ledger。root owns studioWasmRuntimePackage*，engine owns packet preparation/staging；本任务不改它们，只导入原 normalization 函数。

**已有（不重建）**：Draco normalization、Deep GLTF 导入、绑定姿态/活体形变、图片解码、整数盒滤波、UV/材质/资源 ID、预算与严格错误。

**真实缺口**：作者主线程在同一 task 执行 WebIO readBinary、GLTF meshResources 和解码。以可终止资产 Worker 执行原算法；源字节保留，编码副本分片复制并转移，返回原 typed-array 包及规范化字节。取消终止孤立工作，错误保留 GltfImportError 实例判定，旧资产/代际不能发布。

## 验证

8 个 Worker 调度/所有权/错误/取消/预算/共享资产测试及已有 compiler/texture 共 48 tests 通过，日志 `studio-author-model-worker-tests.log`。源拷贝按 4MiB 让出，原 GLB 不 detach；返回 transfer list 按 backing store 去重，别名保持。

最终增加跨 realm normalization-fatal 保持用例，协议 9 tests 全过；Web typecheck 通过（`studio-author-model-worker-protocol-final.log`、`studio-author-model-worker-types-freeze.log`）。

`node scripts/verify-author-model-worker.mjs` 用软件 2D Chrome 对拍静态 Box、带纹理 Box、4096×2048 非对称 RGBA 贴图 GLB 按原预算降为 256×128、原固定 Draco 编码器生成的压缩 GLB、同时含 skin/morph/animation 的活体 GLB。五组 normalizedBytes SHA 与 decoded packet 每个 typed array 的实际字节 SHA 全部相同，源字节不变，主线程 longTasks 均为空；live 样本保持 live 及全部三种 feature。报告 `studio-author-model-worker-browser.json`。

Root 已把 normalization 原文机械迁到唯一 `normalizeStudioModel.ts` 叶，Worker 直接复用该叶，旧 WASM 入口兼容保留；不导入整个 Runtime Package 编译模块。首次 Vite Worker 模块图启动从初轮 743ms 降至下一轮 295ms，后续无主线程长任务。这是开发服务器与软件 2D 调度证据，正式用户场景复采待最终统一构建。
