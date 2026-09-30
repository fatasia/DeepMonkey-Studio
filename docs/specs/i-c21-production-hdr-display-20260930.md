# I-C21 HDR 显示生产桥接

复用 c1e13bbd 显示策略、编码核和 GPU 数值证据，将作者请求接到 Studio → Backend → DeviceSession → PBR present；普通默认保持 SDR。

## 现状核查

1. 全 packages/apps src 检索 hdrDisplay/PQ/toneMapping 与 git status：hdrDisplayOutput、pbrHdrDisplay/Pipeline/WGSL、PbrOutputBindings.applyHdrDisplay 已在用的库入口存在；生产 PbrRenderer 未传 policy，DeviceSession 固定 preferred format，Studio 请求没有字段。没有第二套生产 HDR 会话。未跟踪为其他 J/Native 域与本路已验 hydration，不重建。
2. 已读 contracts rendererCapabilityManifest、PbrRendererOptions、DeviceSession、DeepWebGpuBackend runtime 与 StudioDeepWebGpuBridgeOptions：策略/探测/原因码已闭合，SDR/PQ/HLG编码均有现合同；GPUCanvasContext 的 extended 模式需要 rgba16float 线性输出。真实生产字段与状态缺失。
3. package.json/Cargo.toml 已有 WebGPU types、浏览器 harness 与 Vitest；使用浏览器原生 matchMedia、canvas/getConfiguration/errorScope，不新增依赖或 renderer 平台。
4. 找调用方：PbrRenderer 创建 PbrOutputBindings 的第5参一直空，普通 DeviceSession resize/recovery 只 preferred BGRA；Three Backend 快照关闭未知字段，Studio renderer 字面量未透传。HDR PSO 固定 rgba16float，直接给当前 BGRA surface 会 attachment mismatch；现 captureSource 在HDR激活时抛错，真实 FrameCapture 无法消费。
5. hdrDisplayOutput/pbrHdrDisplay/pbrOutputBindings.hdr 测试和 0929 真实 GPU 28编码样本均已存在，不重复库矩阵。旧报告明确 Studio 未接与真面板未测；新增门只测生产请求→真实浏览器能力→实际 SDR fallback/输出/resource，并补资源候选/重入/取消 CPU 负例。
6. remaining-tasks-estimates-20260930.md 与旧 I-C21 报告：真实余项为 Studio 桥、HDR面板端到端；本机已读 EDID（SHP，扩展块0）及 Chrome headless high=false/standard=true/colorDepth24，headless 信息只用于真实运行能力，不用来宣称物理面板 HDR。物理 HDR 验收保持未测。

已有（不重建）：策略闭字段/原因码、PQ/HLG/extended-linear CPU与WGSL、HDR PSO工厂、16B settings、PBR输出owner、DeviceSession资源账、Bridge候选和替换保护。

真实缺口：宿主请求/真实探测、canvas与PSO格式匹配、生产present消费/状态可读、HDR实际shader provenance与owner回收。

## 接线方案与文件锁申请

默认不传 hdrDisplay：不调用 matchMedia/探针，不升纹理limit，不配置HDR，不编译额外PSO；现 SDR 路径保持。

显式请求先真实 matchMedia，只有 high 才在独立临时canvas试 rgba16float+extended，用 device validation scope 和 getConfiguration().toneMapping.mode 确认字典字段实际消费，临时canvas unconfigure 必须在 finally。能力不足为已有明确SDR原因码。物理canvas仅extended-linear可用，PQ/HLG继续作为已有码流/离屏sink策略；请求它们给物理canvas返回 invalid-probe，不能把PQ编码解释成线性extended。

DeviceSession 先保持 preferred SDR format 构造既有PBR/SDR PSO，HDR present候选编译成功、同device身份/当前generation/owner admission均通过后，才原子配置真实canvas rgba16float+extended。失败保持或复原 preferred SDR；公开 format 改为 current getter，resize/recovery沿同已协商配置，默认行为不变。PbrRenderer.create 在发布前等待 HDR candidate settled；防止仅就绪普通PSO时提前交用户首帧，取消/旧device候选销毁并退役。

PbrOutputBindings 保留已有16B uniform与作者48B/输出32B绑定，HDR资源仍DeviceSession唯一owner；重入/关闭清对应bindgroup WeakMap，dispose释放HDR缓冲，迟到候选不接管新会话。HDR active禁用directDisplay与8bitSMAA，fallback继续原先BGRA输出。captureSource 复用既有生成WGSL的provenance工厂并绑定实际HDR pipeline身份，禁止错误映射为SDR；实际pass计划说明surface rgba16float和SMAA旁路。

生产锁申请：新webgpu/hdrDisplayCanvas.ts/.test.ts；deviceSession.ts与现device测试；pbrRendererTypes.ts、pbrRenderer.ts（create/constructor/status/directDisplay/capture plan窄缝）；pbrOutputBindings.ts/.hdr.test.ts、pbrHdrDisplayPipeline.ts；threeBridge/deepWebGpuOptions.ts/.test.ts、DeepWebGpuBackend.ts（runtime status类型）；apps/web/src/viewer/StudioDeepWebGpuBridge.ts与其测试（请求透传/诊断）。如需 framePlan collector 专用HDR字段，先沿现已有 describePbrPresentPasses(hdr=true)最小接线，不改C8 shader/environment/DFG或Native。

真实GPU仅深色1920×1080，实际生产SDRfallback与关闭身份对照两fresh；物理 HDR high 路当前无面板，不强行注入媒体查询伪通过。CPU mock只用于格式/故障/取消/资源代际，证据明确区分。

## 依据

[Chromium WebGPU HDR canvas](https://developer.chrome.com/blog/new-in-webgpu-129?hl=en) 与 [WebGPU 规范 canvas configuration](https://www.w3.org/TR/webgpu/) 要求 rgba16float + toneMapping extended；[Chromium HDR explainer](https://github.com/ccameron-chromium/webgpu-hdr/blob/main/EXPLAINER.md) 的 compositor 输入为扩展线性值。生产物理canvas策略按此语义收敛；旧PQ/HLG离屏核及数值证据保留。
