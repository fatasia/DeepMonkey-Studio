# 作者纹理解码与降采样移出主线程

解决真实复杂场景 cold 切换中的图片解码 949ms（getImageData 407ms、drawImage 121ms）和盒滤波 295ms 主线程阻塞。

## 现状核查

1. 全仓源码及未跟踪文件已查：useAppRuntimeEffects.deepBridges→compileSceneRenderPacket 使用 browserImageDecoder；textureBudget.capImageDimension 同步逐级 halve。完整 WASM compilation worker 已由主线程完成，不另建整包编译器。
2. GltfImageDecoder/GltfEncodedImage/GltfDecodedImage 已定义：原始 PNG/JPEG 字节、无 ICC/gamma/预乘、顶行在前、兑现前关闭 bitmap；保留此合同。cap 为 Web 组合层可选能力，不扩 Deep 公共 ABI。
3. Worker/createImageBitmap/OffscreenCanvas 均已有，固定 Three/Deep 依赖不变。browserImageDecoder 在 Worker 中已可直接运行。
4. Deep 作者编译、PathTrace/Native payload 与 probeGrid 都消费现有 decoder；完整 WASM worker 消费时继续本线程纯 Offscreen 路径。统一图片层只替换调度位置。
5. 已有 GLB/作者贴图像素、预算、翻行与 SDK/真实 GPU 证据；新增 worker 转移/取消测试与浏览器实际 PNG 解码、原盒滤波逐字节对拍。
6. 已读 studio-quality-continuation、handoff 与本轮 texture/native 文档；root owns studioWasmRuntimePackage*，engine owns packet/deformation 分片，当前任务只 owns 图片 CPU。

**已有（不重建）**：正式 bitmap 解码、像素读取、闭包清理、2×2 整数盒滤波、贴图预算、颜色空间与 flipY 合同。

**真实缺口**：这两段 CPU 在作者编译主线程执行。独立图片 worker 复用原解码/滤波，复制编码子数组避免 detach 共享 GLB；仅最终像素 buffer 转移回主线程；取消立即拒绝调用并清理 worker 临时 bitmap。Worker 失败明确报错，环境无 Worker 才使用既有同步路径。

## 本轮验证

Web typecheck 通过；Worker 调度、取消、字节所有权及既有作者贴图/编译器共 43 tests 通过。最后一个取消任务会终止空闲 Worker，后续懒建新 Worker，避免上一场景的 CPU 工作继续占用队列；其他仍活跃的任务保留。

`node scripts/verify-author-image-worker.mjs` 复用现有 5173 Vite 和 Chrome，使用软件 2D，不占引擎 GPU 基准窗口。4096×2048 非对称 RGBA PNG（3,868,883B、含 alpha）在主线程原 decoder 与 Worker 间 SHA-256 同为 `59b21d957d2ee94635e575ebe674e64257a4425a4fe7b741df4b037ba899bf0c`；降采样到 1024×512 的原盒滤波与 Worker 同为 `a9dc4acf71e3c773a98025eed40be784b99fcf83bd2c98d37d8d044569a167b7`。编码源字节未 detach。

最终 host 类型不依赖 DOM：客户端仅使用消息、错误、转移与终止的最小接口，Worker 构造留在 Web 入口。最新软件 2D 复验，两次解码/降采样含消息与启动共 366.2ms，10ms 心跳 39 次，观察到的主线程 longTasks 为 0。这是调度与字节验收，不是整引擎帧性能。报告 `test-output/studio-author-image-worker-browser.json`；CPU 日志 `studio-author-image-worker-tests.log`、`studio-author-image-worker-scheduling-final.log`。实际复杂场景冷切换由引擎任务继续复采；packet/geometry/GPU staging 的分片由该任务负责。

引擎任务最新实际 complex cold 主线程精栈已确认：原图片 decode 949ms 与 halve 295ms 两段消失。余下约 214ms 是 GLTF normalization/readBinary 与 meshResources，归后继 `studio-author-model-worker-20261007.md`，不归图片像素阶段。
