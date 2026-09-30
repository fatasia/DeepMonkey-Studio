# C8-S3c GGX 相关可见性共享

让 Three Standard/Physical 的各向同性 Smith-correlated visibility 消费已有 Deep BRDF 真源，保留材料与灯光宿主规则。

## 现状核查

1. 源码/未跟踪文件：S3b Fresnel已冻；Three `lights_physical_pars_fragment.V_GGX_SmithCorrelated` 与 `wgsl/brdfDirectLighting.wgsl` 的 gv/gl/visibility 是完整同式，EPSILON均1e-6。不是从GGX分布的合法clamp差异中硬切核。
2. 契约：shader/types、ThreeProjectionHooks与材料合同已存在；只输入alpha²/n·v/n·l的纯数学，不变F0、roughness clamp、light和BRDF权重合同。
3. 依赖：已有WGSL生成镜像、hash、Three0.185.1、Vitest/esbuild与Chrome。无需IR、额外运行库、Cargo/WASM/build。
4. 消费：Deep PBR主直射/visibility resolve/Native mesh实际使用canonical inline visibility；Three Standard/Physical/clearcoat调用各向同性V_GGX。各向异性V_GGX与sheen/iridescence等保持宿主公式。
5. 测试/证据：S3b已覆盖真实lit非均匀roughness/metal/emissive与Fresnel；BRDF checksum已有。尚未共享整个相关可见性项，缺少不同roughness/正视/掠射的跨语言真实数值和Three生产接线验证。
6. 规格：读取C8-S2/S3a/S3b和remaining C8-S3行。完整Three/WebGPU场景共同输入仍后继；本刀存在值得共享的完整BRDF项，先完成此项，不重复显示/Fresnel交付。

**已有（不重建）**：两个宿主的Smith相关项、材料体系、PBR renderers、已有配对装配与测试设施。

**真实缺口**：完整相同的Smith-correlated visibility仍由Three另存副本；已有canonical尚未成为该材质项的公共来源。

## 最小交付

严格提取既有canonical的三个inline声明，生成同语法的GLSL helper（仅let→float，原变量/表达式/常量保留）。Three现有V_GGX只保留alpha→a2，再调用共享helper；固定原函数/源块身份，拒绝漂移。Three NDF/roughness/F0/F90/多散射/灯光/各向异性项不改。Deep/WGSL/Native源无需变更。

应用沿用现有每realm装配，首次编译前同时安装common Fresnel与physical可见性项。只追加该chunk身份，不覆盖材料hooks。聚焦测试验证其它内容逐字保留、负例/幂等/漂移及两创建接缝。

GPU预注册：GLSL/WGSL共同输入alpha²与n·v/n·l，roughness0.045/0.2/0.8/1及正视/掠射/零边界；值必须finite且与独立CPU参考相对误差≤2e-5（绝对floor1e-6）。真实Three原始/共享项在lit非均匀材质上RGBA8最大差≤1，两freshrealm轮dark1920×1080。GPU由根预约；未实施前不宣称通过。

## 已实施与验证

`ggxVisibilityLibrary` 严格提取现有canonical三个声明，生成WGSL与GLSL wrapper；只将GLSL中的let替为float，乘法顺序和括号不动。整个源块SHA `915630280aad91faa1e49050dbae9564538df2f4dd883d0c2f159c3bd6ff4d27` 固定，生产模块20行。Three helper14行，只替换既有V_GGX定义，保留原alpha平方，再调用共享项；NDF/其它physical内容逐字保留。

应用installer先校验两个源块与common中EPSILON1e-6，再原子赋值，错误不留半装配。WeakMap同时检查common/physical身份，保持每realm幂等。既有主线程/worker接线沿用，不新增另一套启动设施。S3b lit probe仅追加真实compiled fragment观察与physical finally恢复，新probe直接复用它，未复制材质场景平台。

六文件40focused通过（core35/web5），含源块/epsilon/乘法序/alpha/缺失/重复/已适配/装配后漂移、原子失败和旧hook拒绝；deep-engine core/lab及web类型、runner语法、diffcheck通过。

`node scripts/c8-three-ggx-visibility-parity.mjs` 两freshrealm轮通过：每轮8个真实lit Standard/Physical配置和64组Three原始GLSL/共享GLSL/共享WGSL三路Float32数值。roughness0.045/0.2/0.8/1，nv/nl各0/1e-7/0.3/1，按f32量化共同输入，包含epsilon钳位和零点有限极限。最大相对跨语言差`7.416138114663087e-8`，独立CPU参考相对误差`8.642176863647593e-8`，均低于预注册2e-5；两个cosine为0时visibility500000保持finite，未把巨大有限值误报为奇点失败。WGSL来自正式生产源块，同矩阵验证不等于完整WebGPU场景通过。

16个实际Three材质帧的RGBA8差均0，直射关灯差覆盖7921–9082像素，两轮数据完全稳定。实际compiled lit fragment确认公共Smith调用；所有GL/WebGPU/compiler/page errors为0，WebGPU使用非fallback adapter。原Three physical完整源SHA `1206d7e3bb4e608a4cf395b164c8a0e80d84f8ae80fad065347874c22303946f`，装配后`a8de892b38a848bb535a8d7830a3cb3f2e130493aa5ad852046677e2bb7d331c`。

证据：`test-output/interrupted-0930/c8-ggx-visibility/evidence.json`、`rounds.json`、`round-{1,2}.png`。包含9个canonical/生产/probe/runner源SHA，每次删除旧通过证据，完整两轮才写新结果。读回buffer/device、GL材质/target/context/browser/server均finally释放；复用probe恢复common/tone/physical源。该probe要求freshrealm，重复使用已恢复源的同一realm会触发生产漂移门，runner每轮新页面遵守此约定。未运行Cargo/WASM/共享build。

## 视觉范围与后继

两轮深色1920×1080截图均已查看，八组原始/公共数学双栏完整、无遮挡。对标 [Three r185相关Smith生产公式](https://github.com/mrdoob/three.js/blob/r185/src/renderers/shaders/ShaderChunk/lights_physical_pars_fragment.glsl.js) 与 Unity PBR/ACES管线语义，范围为诊断材质场景。

| 维度 | 评分/本轮范围 |
|---|---|
| 布局构图 | 9：八组双栏完整可读 |
| 令牌一致性 | 9：base.css深色文字/背景；材料为测试输入 |
| 排版 | 9：标题与材质/视角/色彩空间层次明确 |
| 交互状态完备 | 不适用：没有产品交互改动 |
| 动效质量 | 不适用：没有动画改动 |
| 3D渲染质量 | 9：16实际材质帧逐字节保持，粗糙分区/金属/自发光可见 |
| 信息设计 | 9：按同材质和视角并排原始/共享数学 |
| 反馈即时性 | 不适用：无交互或性能测量 |
| 响应式与主题 | 9：按用户最新要求仅深色1080 |
| 语义与文案 | 9：共同数学与完整场景范围明确 |

同族覆盖Standard/Physical/clearcoat的各向同性调用、两编译realm接缝、两个chunk的错误/漂移/恢复。完整Three/WebGPU共同root场景与差异分层是下一个交付；不继续无休止提取函数。全部BRDF一致性、实际offscreen worker场景、完整IBL/灯光/后处理和性能测量仍未在此首刀覆盖。pbrRenderer/DeepWebGpuBackend生产源保持不变。
