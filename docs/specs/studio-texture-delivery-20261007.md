# Studio 贴图与交付续作（2026-10-07）

负责 Deep 实际后端贴图视觉验证与 Runtime Package / 离线包贴图资源闭合。保护其它会话改动，不提交或推送。

## 现状核查

1. 全仓源码和未跟踪文件：已检索 MapUrl/loadTexture/imageDecoder/compiler，并核对 git status。AuthorTextureResolver 与五槽接线已存在；本分支不接管 Native MegaLights、图谱、LOD 或 benchmark 文件。
2. 契约：SceneMaterialState 五个静态 PBR 贴图槽、UV 变换及 slotOverrides 已定义；RenderPacket 已定义解码纹理和材质槽。无需新增 GPU 或场景合同。
3. 依赖：deep-engine、GLTF 解码器、Three、Sharp 测试解码及 JSZip 已有，不加依赖。
4. 消费方：Studio WebGPU 原生编辑器已传 loadTexture；compileSceneRuntimePackage 继承该选项却丢失透传，Native 打包器已捕获 sourceBuffers 却只供 loadModel；WASM 编译同样遗漏。
5. 测试/证据：已读五槽编译测试、runtime 编译证据测试、真实 ZIP prepared Native 测试及 CLI 归档校验器。历史贴图截图显示 fallback WebGL，不能作 Deep 原生视觉证据。
6. 规格：已读 13:36 交接、studio-quality-continuation、deep-material-gaps、Native texture closure 及台账对应条目。

**已有（不重建）**：作者贴图解码/去重/预算、MR 合成、切线生成、GLB UV、离线资源捕获/重写/哈希、独立 Runtime Package 解码纹理载荷。

**真实缺口**：runtime 编译透传、离线冻结字节供给、WASM 加载接线、纹理来源编译证据及归档守卫；真实 Deep 视觉证据。

## 实现与边界

复用 AuthorTextureResolver。Runtime 编译记录去重后的纹理源字节/内容哈希，统一资源预算；无贴图旧包保持字节与证据规则。Native 只消费准备阶段校验的 sourceBuffers，不二次抓取 URL。取消、缺失、格式、UV、预算、损失均按原严格语义拒绝。增加真实图像解码的 runtime/ZIP 测试与反例，并核验 CLI。

Design Read：PBR 纹理以 Unity 渲染管线语义为准，同相机/材质/环境检查；本次不改 UI 色彩令牌，遵守 base.css。视觉必须显示实际后端诊断，至少两轮，补资源/体积数据。

## 验证与遗留

Runtime、Native ZIP、API 冻结资源 worker、WASM 已透传作者静态五槽图片。源纹理按内容 SHA-256 去重、计入统一预算和 compileGraphHash；没有贴图的旧包保持原身份。ZIP 的 runtime-package.json 单独 DEFLATE level 3，已压缩图片/模型保持 STORE；测试确认完整 ZIP 小于对应全 STORE 包。CLI 恢复作者 URL 后核验语义源身份，再核对包内纹理的内容、字节数和预算。

验证：runtime/ZIP/基础编译 50 tests；API prepare/真实独立构建 worker 22 tests；frozen/client/resources/texture overrides 51 tests；最终新增路径重跑 33 tests；Node CLI archive 90 tests。API typecheck 通过；主线程已成功重建 API 生产 compiler。真实解码反例覆盖缺失图片、错误格式、取消、编码/解码预算与 hash 漂移；ZIP 删除 sourceTextures、frozen 删除 sourceTextures 均拒绝。

视觉样本为自建 128×128 棋盘 PNG（651 bytes，SHA-256 2decf7e47e863cb0f66be0b6a1e29b52a24166bb8cbda6a7d955cf691667d116）和官方 BoxTextured GLB 衍生 UV 小方块（5760 bytes）。只复制 QA 场景后隐藏原对象，原场景未改。验收副本 ID 3752891a-ab77-483f-996c-e3340021ad0f。

证据目录 `test-output/studio-texture-delivery-20261007/`：deep-round1.png、deep-round1-backend.png/txt、deep-round2-uv2.png、deep-round2-canvas.json、webgl-uv2.png。两轮可见 Deep canvas 的 data-renderer-backend=deep-webgpu、opacity=1，Three canvas opacity=0；诊断记录 24 帧 / 48 个 WGSL Source Map 映射。基础色图片三面正确显示；第二轮 U/V 改为 2× 后 Deep 仍显示 8×8，WebGL 同状态显示 16×16。相机位置一致，Deep 灰白背景、WebGL 深色地网，物体明暗存在差异。此处交由 engine_lod_switch 接手 bridge 一致性，不把两轮截图记作视觉通过。

Kimi-95 十维自评（本次渲染语义验收）：材质/贴图 8、UV 实时一致性 4、光照 7、环境 5、后处理 7、空间层级 8、编辑交互 8、中文信息 9、状态反馈 8、跨引擎一致性 4；未达到 95% 门槛。对标依据为项目要求中的 Unity 显式 PBR 与相同作者参数。CPU 发布资源链路完成；五槽组合的真实 Native 窗口、三引擎效果一致性、真实发布应用下载/安装全链仍由后续任务验收。

## 第二轮修正回填

作者 TextureLoader 默认 flipY=true，而作者覆盖图解码为 top-down RGBA。`sceneTextureOverrides.ts` 在单图与降采样两条路径翻行，MetallicRoughness 使用已翻向图，GLB 内嵌图保持原合同。非对称上下红/蓝图断言方向且原 decoder bytes 不被改写。修后 focused 47 tests、web typecheck 通过；最终发布 compiler 必须重建。

engine_lod_switch 已修实时 UV、作者曝光与显式关闭的体积雾。最终同相机截图为 `test-output/studio-engine-lod-switch-20261007/webgl-uv2-final.png`、`deep-uv2-final.png`：两者 16×16 棋盘方向与相位一致；背景三个像素 RGB 最大差 1/0/1。材质 ROI 的 RGB 差 5/20/14，光照一致性仍待校准，未把 UV/背景修复扩称全效果验收。像素证据为同目录 `same-camera-color-samples.json`。
