# C8-S2 Three 输出生产接线首刀

本轮把 C8 配对 GLSL 的 Three ACES 拟合接入现有作者视口 OutputPass。设计立场：用户已有曝光、调色和色彩空间设置继续决定画面；只消除 ACES 实现漂移。

## 现状核查

1. 全仓源码和未跟踪文件核查：已有 `displayColorLibrary`、配对 WGSL/GLSL、DCIR、Three 投影桥；不重建 IR、渲染器或显示管线。`postProcessingRuntime.ts` 真实创建 OutputPass，`materials.ts` 只做 RenderPacket 投影，不是输出接缝。
2. 契约：已有 `ScenePostProcessingState` 六通道作者调色和 `ViewerPostProcessingRuntime` 生命周期。作者 contrast/saturation 以 0 中性，C8 库以 1 中性；不能整段替换调色。
3. 依赖：已有 Three 0.185.1、EffectComposer/OutputPass、Vitest、esbuild；不新增运行依赖。
4. 消费：主线程 `viewerEngineRendering.ts` 与 worker `offscreenPostProcessing.ts` 都消费该运行时。材质 onBeforeCompile 的 rim emissive 留在已有路径。
5. 测试与证据：已有作者 AA 顺序测试、C8 库测试、J3 双 GPU 输出对拍；生产 OutputPass 尚未消费配对库，这是实际缺口。
6. 规格：已有 C8 首刀规格和当前交接记录。此切片补生产消费，完整场景、完整双后端统一着色器仍是后续范围。

## 实现范围

在 OutputPass 初始化时装配一次配对 GLSL，只改 `ACES_FILMIC_TONE_MAPPING` 分支的拟合调用。保留所有其他 tone mapping、Three sRGB 传递、透明度、曝光 uniform、六通道调色顺序与 AA 顺序。纯 source helper 不持有 Three 宿主或 GPU 资源。

Three RawShaderMaterial 使用默认 GLSL ES 100；配对库两处布尔向量 mix mask 改成显式 float mask，使同一文本兼容 ES 100/300，数学不变。库目标标签仍为 `glsl-es-300`，宿主不升级 GLSL 版本。

装配时检查上游 ACES 调用和 main 各恰好一处；上游结构变化、重复装配直接抛错。没有帧内源生成，也没有新增 pass/纹理/渲染目标。

## 验证范围

聚焦测试检查真实 OutputShader 的其他分支和颜色传递保持原样、上游漂移拒绝、生产真实 OutputPass 消费、作者调色保留。GPU 验证使用真实 Three OutputPass 与固定 HDR 纹理，覆盖曝光、非 ACES 模式和两轮重建；另检查 ES 300 实际编译。预声明 ACES 容差为 RGBA8 每通道最多 1，非 ACES 必须逐字节相同。

这里不评定完整园区/建筑场景、材质、灯光、Bloom/SSAO 组合、完整后处理端到端跨端一致性或性能提升。设计令牌没有变化；截图与评分只评本切片的色彩保真和输出稳定性。

## 本轮结果

`node scripts/c8-three-output-parity.mjs`：两次创建全新 renderer/texture/pass，共 10 配置 × 2 轮。ACES 曝光 0.25/1/3、ACES 线性输出以及 None/Linear/Reinhard/Cineon/AgX/Neutral 全部最大通道差 0；两轮输出稳定。真实默认 ES 100 OutputPass 与同源 ES 300 编译通过，GPU 错误 0。

证据：`test-output/interrupted-0930/c8-three-output/evidence.json`、`rounds.json`、`round-1.png`、`round-2.png`。GLSL 源身份为 `ed71f5fb3bcacbc659a27a1996e150e98bd5ce2c14bb14b7bc618ae4c8414879`；旧证据在新运行开始前删除，失败退出不会留下通过标记。浏览器、服务、GL shader/pass/纹理/目标均在失败路径释放。

聚焦 Vitest：4 文件 23 项通过（源装配、上游漂移负例、生产消费、调色、AA 顺序、配对库）。deep-engine 核心和 web 类型检查通过。lab 全量类型检查曾发现并行 J2 probe 的可选字段类型错误，其拥有者已修复并复跑通过。

同族排查：作者 worker 共用该运行时，因此同一消费接线适用；未启用 composer 的直渲路径保留原样；Three 投影桥、材质注入、WebGPU/Native 作者调色契约没有由此切片改动。没有新增帧内计算、GPU pass 或资源，FPS 和冷编译时间未测。

## 切片视觉自评

对标依据是本机固定 Three 0.185.1 的 `OutputShader`/`OutputPass` 和 [Three 官方 OutputPass 文档](https://threejs.org/docs/pages/OutputPass.html)。官方约定 renderer 决定输出 tone mapping/色彩空间，FXAA 在输出后；本切片保留该约定。ACES 满足工作区 Unity 渲染基线中的色调映射项；园区氛围、钻取、工业信息密度不在此切片。

已逐张检查两轮实际浏览器截图：左右色条相同，无额外裁切、黑输出或色偏。10 维度按本次改动范围评分，N/A 不折算分数，也不表示完整产品验收：

| 维度 | 分数/适用范围 |
|---|---|
| 布局构图 | N/A，无产品布局改动 |
| 令牌一致性 | N/A，无产品样式或令牌改动 |
| 排版 | N/A，无产品文本改动 |
| 交互状态完备 | N/A，无交互改动 |
| 动效质量 | N/A，无动效改动 |
| 3D 渲染质量 | 10/10，仅输出色彩：20 次真实 GPU 比较差值 0 |
| 信息设计 | N/A，无信息展示改动 |
| 反馈即时性 | N/A，无交互或耗时指标测量 |
| 响应式与主题 | N/A，无视口布局或主题逻辑改动 |
| 语义与文案 | N/A，保留用户设置语义，未改产品文案 |

完整场景 Kimi-95、性能基准和跨端全管线验收仍未覆盖；本轮只完成 C8-S2 的生产 ACES 消费切片。
