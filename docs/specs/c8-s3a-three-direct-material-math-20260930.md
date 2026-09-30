# C8-S3a Three 材质直渲显示数学

在既有 Three WebGL 的标准材质直渲中消费配对库的 ACES 拟合，保留材质、曝光和色彩空间设置。

## 现状核查

1. 全仓源码与未跟踪文件：已有配对 displayColor、Three OutputPass 生产消费；materials.ts 是 RenderPacket 投影，不是直渲输出接缝。
2. 契约：ThreeProjectionHooks 与 material render hooks 拒绝守卫已存在；公共显示数学和 three-aces-r185 已存在，不增 IR/renderer/材质合同。
3. 依赖：已有 Three 0.185.1、Vitest、esbuild 和产品 CI Chrome；无需新运行依赖。
4. 消费：ViewerEngine.create 与 offscreenScene.worker 初始化 WebGLRenderer；禁用 composer 时 renderer.render 直接使用 Three tonemapping_pars_fragment。现有 rim onBeforeCompile 作者路径继续保留。
5. 测试与证据：ThreeProjectionBridge 已验证自定义 hook 拒绝；C8-S2 两轮20帧只验证 OutputPass，不能覆盖材质直渲。生产直渲两接缝尚未消费公共拟合。
6. 规格：遵循 C8 首刀/S2 与当前handoff；本轮只补剩余直渲 ACES，灯光/完整后处理不是本轮范围。

**已有（不重建）**：双后端配对源、OutputPass ACES、Three 全部其它 tone mappings、材质作者 hook/桥拒绝、worker直渲。

**真实缺口**：主线程与worker直渲仍编译 Three 内置 ACES 数学副本。

## 实施

纯 source helper 从现有配对 GLSL 取 deepThreeAcesFit 定义，只替换固定 Three r185 ACES 函数。应用层在首个 renderer 创建/编译前装配其当前 realm 的 ShaderChunk。每个 chunk 对象只缓存一次 original/adapted 身份；当前源漂移报错，已适配且身份相同幂等。保留所有其它函数和输出顺序。

原始 ACES 定义整体 SHA-256 `e33185b708236b7401db999659b876abab6bae06e0049e6d5e5bec288f785281` 同时约束矩阵、曝光和运算顺序。直渲只引入约 750 字节的现有拟合，不把完整 grading/transfer 库带进每个材质程序。OutputPass 同时包含 tone chunk 和输出库；两处共享 `DEEP_C8_PAIRED_THREE_ACES_FIT_V1` 条件定义，避免实际组合后的函数重定义。数学真源与 sourceHash 保持不变。

不修改 onBeforeCompile、onBeforeRender、customProgramCacheKey 或材料投影守卫。现有 ShaderChunk 是 realm 内共享表；此数学兼容装配沿用它的范围，不持有其它 realm，也不维护逐材质副本。新 helper 不分配 GPU 资源，不进入逐帧路径。

## 验证

先 focused 检查真实 Three chunk、其它函数逐字保留、source身份/幂等/漂移、生产首编译前接线与旧 hook 拒绝；再在根授权的GPU时段运行真实 MeshBasic/Standard/Physical 的 direct render 原Three与共享拟合比较。

已运行六文件37项 focused：公共 helper/S2 装配/旧材质 hook 拒绝30项，应用 installer/两生产接缝/OutputPass/AA7项；全部通过。deep-engine core/lab 与 web TypeScript、runner 语法、diffcheck 均通过。

`node scripts/c8-three-direct-display-parity.mjs` 在真实 Chrome GPU 两个新页面 realm 中分别创建原始与装配后的 WebGLRenderer。每轮18个 MeshBasic/Standard/Physical 默认 framebuffer 配置，涵盖 ACES 曝光0.25/1/3、ACES Linear-sRGB、Linear、AgX；再验证两个 OutputPass 组合配置。12个固定 HDR/灰阶/高饱和输入、96×32数值画布。Standard/Physical 用 emissive 隔离输出数学；未评价灯光与 BRDF。

ACES RGBA8 最大差预声明1，其它 tone mappings 最大差0；实测40个配置最大差均0，两轮像素和 source 身份完全稳定。真实 renderer.info.programs 的 fragment source 均含公共拟合调用；生产 installer 修改当前 Three realm，编译/GL/page错误0。不是在普通 render target 中误测绕过 tone mapping 的材质输出。

证据为 `test-output/interrupted-0930/c8-three-direct/evidence.json`、`rounds.json`、`round-1.png`、`round-2.png`。runner 每次先删除旧通过证据，完整两轮才写新通过结果；资源在 finally 中 dispose/forceContextLoss，浏览器和本地 server 关闭。原始 Three chunk `0e82e57cbc2747a20901ef227078f8d440edd6fb7cab807c525e09e5fe000e78`，装配后 `efb0660923f455445f9a08e6a86b5320817653cba3184c9c4ba431325db00f30`，GLSL真源 `ed71f5fb3bcacbc659a27a1996e150e98bd5ce2c14bb14b7bc618ae4c8414879`。

## 视觉范围与评分

按用户最新指令，仅深色1920×1080，两轮截图已查看。对标 Three r185 原始 tone-mapping chunk 的输出兼容及 Unity ACES 渲染流程；没有重做产品 UI。截图为读回像素并排检视，两个栏分别是原 Three 与公共拟合，20行完整显示，无截断/遮挡。

| 维度 | 本轮评分/范围 |
|---|---|
| 布局构图 | 9：20行及双栏完整可见 |
| 令牌一致性 | 9：页面沿用 base.css 深色背景/文字；色条是测试值 |
| 排版 | 9：材质、模式、曝光层次清晰 |
| 交互状态完备 | 不适用：静态数值检视；生产交互未改 |
| 动效质量 | 不适用：未改动动画 |
| 3D 渲染质量 | 9：本轮输出数学兼容，40配置逐字节一致；完整scene未测 |
| 信息设计 | 9：逐材质/曝光/色彩空间对照 |
| 反馈即时性 | 不适用：无交互或性能测量 |
| 响应式与主题 | 9：按最新用户要求仅深色1080；其它矩阵未测 |
| 语义与文案 | 9：原始/公共拟合和测试配置范围明确 |

同族核查覆盖主线程与 offscreen worker 的 WebGL创建接缝、Basic/Standard/Physical、S2同时使用同chunk，以及现有自定义材质 hook 拒绝。worker realm 接线通过源码与类型检查，真实 worker/offscreen场景未运行；完整光照/环境/全部tone模式/用户shader作者流/GPU性能均未在本轮宣称完成。
