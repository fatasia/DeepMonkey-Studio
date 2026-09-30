# C8-S4 共同作者 root 的生产全链对照

同一作者模型驱动正式 Three 与 Deep WebGPU，分层检查投影、自发光HDR、直射响应和显示输出。

## 现状核查

1. 源码与未跟踪文件：已有ThreeProjectionBridge、DeepWebGpuBackend.create/prepareScene/sync、Three生产显示/材料公共数学；已有FrameCaptureSession和present-color HDR读回。S3a/b/c已提交，不重复提取函数。
2. 契约：ThreeObjectSource/ThreeProjectionHooks、RenderPacket、RenderView/WorldClusteredLights、PbrRendererFeatureOptions和frame readback快照均已有。
3. 依赖：Three0.185.1、正式WebGPU backend、esbuild/Vitest/Chrome已在用，不建renderer/投影/IR或新运行依赖。
4. 消费：StudioDeepWebGpuBridge已有author root→ThreeProjectionBridge路径；模型group与灯光经projectThreeWorldLights分开投影。桥拒绝把Light混入可渲染模型root，本刀遵守现有合同。
5. 测试与证据：S3c已验Three真实材质及GLSL/WGSL数学矩阵；J3正式geometry/HDR对拍归其它路线。尚无同root同profile的Three/Deep生产场景分层证据。
6. 规格：读取C8首刀/S2/S3a/S3b/S3c与remaining C8-S3行；下一项是全链共同输入，不继续拆小函数。Gate E设备恢复方案在途，本刀只用无loss正式路径。

**已有（不重建）**：两生产backend、作者投影/灯光投影、显示/材质数学、GPU capture/readback。

**真实缺口**：完整无loss生产帧尚未在同作者模型和冻结profile下给出严格一致子集与合法BRDF差异诊断。

## 冻结输入与范围

单一Three Group为两端可渲染root，六个标准PBR网格，固定sphere/box geometry、world matrices与材料参数。宿主Three.Scene容纳该root及唯一DirectionalLight；Deep使用既有projectThreeWorldLights读取同灯，保持桥对Light的拒绝规则。Root/packet/配置摘要进入证据，不另造投影。

数值尺寸320×192、pixelRatio1、无MSAA/TAA/空间AA。两固定相机：front eye(0,0,9)与oblique eye(3,2,9)，target(0,0,0)、up(0,1,0)、FOV45°、near0.1/far100。曝光0.5/2，Two hosts同ACES `three-aces-r185` 与sRGB输出，背景黑。方向灯使用同作者世界位置/target、线性颜色和强度。

strict-emissive：baseColor0、禁所有灯/环境、六个不同线性emissive输入≤1；metalness0/0.5/1与roughness0.15/0.55/0.9保持真实材料输入。阶段direct-diagnostic恢复非零baseColor和同作者灯，emissive保留用于稳定基线。初刀不扩纹理/透射/透明/作者shader/完整IBL/后处理。

两端关闭ground/grid、environment、fog、AO、SSR、TAA/spatialAA、Bloom/vignette、接触阴影、遮挡裁剪；作者网格cast/receiveShadow=false，灯castShadow=false。Deep小阴影资源配置只满足现有管线绑定。pbrRenderer/DeepWebGpuBackend生产源不改，不跑Cargo/WASM/sharedbuild。

## 误差预注册

输出采用已有中性作者colorGrading（hue/saturation/brightness/contrast均0），选择正式HDR→output路径；Three的对应中性变换为恒等。完全关闭作者effects的Deep单pass直显优化不写HDR，不能用其present-color快照作HDR证据；该快路径属于本刀未测范围。

必须同root/profile摘要、正式packet实际六实例、Three六次绘制与Deep两种几何合批绘制≥2次、非空覆盖≥1000像素、finite HDR、黑corner。Strict-emissive稳定内部像素（双方3×3同mask）≥1000；HDR最大绝对差≤0.002，display最大RGBA8差≤2。轮廓差只能在双方真实边界1px内，缺整块几何必须失败。显示输出来自正式default/surface framebuffer，HDR来自Three实际Float target与Deep正式present-color readback。

direct-diagnostic不宣称完整BRDF同式：Three r185的直接多散射、NDF分母clamp与Deep合同差异保留。须真实关灯基线相比非零直射贡献≥1000像素，记录HDR/显示差统计和具体公式差异；不以放大容差把未知差异冒充一致。output profile始终冻结，两曝光与相机覆盖生产输出路径。

两freshrealm轮，仅深色1920×1080截图；CPU负例验证维度/身份/非有限/全黑/缺几何/超HDR/超显示/无光贡献/重复camera矩阵。使用既有backend与读回，不建立第二验证平台。

## 实测结果

`node scripts/c8-shared-scene-parity.mjs`两fresh realm轮通过，16对正式场景帧；非fallback Nvidia/Lovelace WebGPU，DeepBackend为deep-webgpu、device ready。每轮8个配置为2阶段×2相机×2曝光；根摘要、正式发布packet摘要与profile摘要随帧存证。Three六次draw、2196三角形；Deep两几何实例batch加一次output，共3次draw、2197三角形。

严格8腿：HDR最大绝对差0.0002929568290710449（rgba16float量化），RGBA8最大差1；轮廓差0，稳定内部4328–5027像素。诊断8腿：每端真实灯光贡献4568–5428像素，HDR最大差0.023403823375701904，RGBA8最大差6；该组保留BRDF差异，不进入严格一致声明。两轮全部数值完全相同。

中性作者配置：hue/saturation/brightness/contrast均0、temperature/tint省略归零、vignette省略。正式`pbrAuthorColorEffectsWgsl.ts`跳过hue与brightness/contrast，saturation乘0、白平衡gain为1；本刀颜色亮度高于1e-6，亮度归一化为1，黑背景仍0。`pbrDirectDisplay.ts`因显式colorGrading选择HDR路径；`pbrRenderer.ts`实际present-color送入`outputs.present`和正式readbacks。同一profile在证据中完整保存，fixture专项确认黑/六发光输入/HDR中性变换。

证据：`test-output/interrupted-0930/c8-shared-scene/evidence.json`保存源码SHA、实际bundle SHA、两轮指标与profile；`rounds.json`保存真实HDR/实际surface数据；`round-1.png`/`round-2.png`为深色1920×1080截图。失败启动不写通过证据，GPUscope/设备/Three对象和server/browser均在finally释放，晚到create有AbortSignal守卫。

CPU：fixture与中性profile2tests、比较器12tests通过，runner语法通过。GPU后仅修runner清理顺序（先清历史证据，再读取源码），GPU逻辑和bundle不变；证据保留实际运行时runner SHA，不冒充修改后重跑。并行I路线的ArrayBuffer类型已修，根最终lab tsc通过，日志`test-output/interrupted-0930/c8-s4-lab-final.log`。

截图两轮已看：八组场景完整可见，标题/标签无裁切，左右位置/曝光/颜色可直接比较。10维评分限定于证据页：层级8、字排8、间距8、色彩8、对齐9、密度8、材质9、光照8、动线8、完整性9（83/100）；视觉对标Unity的显式PBR与ACES、Siemens的克制对照布局。该数值证据页不认证Studio完整UI、雾/IBL/后处理、动画或性能。

未测：作者directDisplay单pass HDR捕获、纹理/透明/透射、完整IBL/后处理、设备恢复、全BRDF等价与性能；上述范围保持后继。已知合同差异包含r185多散射/Deep NDF边界，但本刀没有逐像素归因；后继应以同root输入继续分层定位，不重复拆取小函数。
