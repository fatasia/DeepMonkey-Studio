# C8-S3b 材质 Fresnel 因子共享

把 Three 标准/物理材质的 Fresnel 指数因子接到已有 Deep 直射 BRDF 真源，保留各宿主材质和灯光语义。

## 现状核查

1. 源码与未跟踪文件：`wgsl/brdfDirectLighting.wgsl` 已包含 exp2 Schlick 因子；WebGPU 主直射和 Native `frame_bindings.rs` 已消费同源。Three r185 `common` 的 scalar/vector `F_Schlick` 各复制同一指数。S3a 已完成显示数学，不重复交付。
2. 契约：shader/types 与 ThreeProjectionHooks 已定义完整材料/作者入口和拒绝规则；本轮不增合同、不改材料 hook。
3. 依赖：Three0.185.1、已有 WGSL→TS镜像、sha256工具、Vitest/esbuild/Chrome验证栈已在用；不引入 IR、转译器或运行依赖。
4. 消费：Deep PBR/visibility resolve/Native 主shader使用 brdfDirectLighting 真源；Three Standard/Physical 直接与间接照明调用 common.F_Schlick。主线程/worker 首次 WebGLRenderer 创建是已有真实接缝。
5. 测试与证据：BRDF checksum、PBR/cluster GPU和CPU测试、材质 hook拒绝、S3a直渲已有；缺少材料光照下由共同指数驱动的 Three 真实消费及非均匀roughness/metal/emissive验证。
6. 规格：C8首刀/S2/S3a 与本日handoff均将材质列为后继。此次只取同义指数，不把显示颜色当材料数学。

**已有（不重建）**：Deep direct BRDF 单源、各宿主灯光/roughness/F0/F90/归一化、Three材质体系、DCIR/配对库接缝。

**真实缺口**：Three 两个 F_Schlick overload 中的指数仍是独立副本，没有消费 Deep 真源。

## 最窄范围

只共享 `exp2((-5.55473*cosine-6.98316)*cosine)` 的 scalar因子。该表达式在 WGSL/GLSL 的运算符与 exp2 语法相同，可从已有 WGSL 生成镜像提取并严格校验表达式结构；生成纯 GLSL helper，不维护第二份数学常量。Three overload 仅将原指数赋值改为 helper调用，保留 F0/F90 混合及其原顺序。既有 Deep shader原样消费原指数，无 WGSL、Native或sync改动。

GGX NDF 不强行整合：Three 用 `RECIPROCAL_PI*a2/denom²`，Deep 用 `a2/max(PI*denom²,1e-6)`；低roughness/尖峰附近分母策略不同。`surfaceLowering` 的 pow5 Schlick 也与 exp2近似不同，本轮保持原样。

纯helper沿用已有GLSL库装配与每realm source身份/漂移拒绝方式；不建立通用WGSL转译器。固定 Three 两 overload整体身份，改版或未知结构明确失败。首次 renderer编译前接线，常量提取/装配仅一次；逐帧无新资源、hash或解析。

## 验证计划

focused检查严格指数源提取、原Three两overload/其它common函数逐字保留、漂移/重复拒绝、两生产接缝、旧materialhook拒绝。真实Chrome两轮深色1920×1080，实际Standard/Physical球体与光照，空间非均匀roughness纹理、金属/非金属与不同emissive；原始与共享因子输出对照。RGBA8预声明最大差1，非空覆盖/真实compiled source必须满足；两轮freshrealm稳定。小型scalar GPU数值点包含正视/掠射与中间角度，独立CPU指数参考并保留现有f90行为。

对照依据为 [Three r185 common](https://github.com/mrdoob/three.js/blob/r185/src/renderers/shaders/ShaderChunk/common.glsl.js) 与 [GGX宿主源码](https://github.com/mrdoob/three.js/blob/r185/src/renderers/shaders/ShaderChunk/lights_physical_pars_fragment.glsl.js)。

## 实施与结果

`schlickFactorGlsl` 从既有生成镜像提取唯一 fresnel 函数中的指数表达式，验证函数整体 SHA `a0ad3deabcd1d7bc9ac57e920bdb7e90fac233b6035aa482ed67a5b5e24db190`，缓存一次生成的20行模块输出。没有另一份生产数学常量或新转译平台。`threeFresnelShader` 仅将 common 两overload内的指数赋值改为公共因子调用；两原定义整体SHA锁定，所有其它common内容、F0/F90混合及运算序逐字保持。

`threeMaterialMath` 在主线程与worker创建首个WebGLRenderer之前装配本realm的common，WeakMap按chunk对象幂等，装配后漂移明确报错，不触碰材料 hooks、编译缓存策略或其它realm。新生产模块为20/24/16行；GPU probe100行、runner86行，均低于300行。

六文件37项focused通过：core33项覆盖canonical提取、公式/F90/缺失/重复/装配漂移、原Three其它函数保留、既有hook拒绝与BRDF校验；web4项覆盖材料/显示两installer及首编译接线。deep-engine core/lab、web类型检查、runner语法与diffcheck通过。

`node scripts/c8-three-material-math-parity.mjs` 已在真实Chrome两freshrealm轮通过。每轮8个Standard/Physical×front/oblique×sRGB/Linear-sRGB配置，各场景6个球体；roughness纹理有四个非均匀分区、metalness0/0.5/1、不同emissive、Directional+Point真实直射，Physical保留IOR1.7/specularIntensity0.6/clearcoat0.35。两种版本使用同fixture和S3a显示装配，只改变Fresnel指数来源。RGBA8阈值预声明1；实测16帧差均0，轮间完全稳定。

每帧以实际关灯后读回验证直射贡献，差异覆盖7921–9082像素，均有6次draw及实际三角形。实际compiled fragment source包含公共因子调用，避免把只含自发光的图误当材料验证。RawShaderMaterial Float32数值点涵盖cosine0/0.001/0.1/0.35/0.6/0.9/0.999/1、F0三个通道与F90的0.2/0.7/1；scalar/vector原始与共享输出差0，独立CPU参考最大误差`3.463488429389372e-8`，低于预声明2e-6。GL/编译/page errors均0。

证据位于 `test-output/interrupted-0930/c8-three-material/evidence.json`、`rounds.json`、`round-{1,2}.png`。通过证据包含8个canonical/生产/probe/runner文件SHA；每次先删除旧通过证据，完整两轮才写新结果，所有临时GPU资源/context/browser/server在finally释放。canonical BRDF SHA保持`af415d45995fdb86f456cbf26dd8f550cfe9ea2dadf2637ff601e9a775d712c7`；原Three common `dc3c6539c5a37424ce7121af933d456a7bb254bd56e8b7c36da8198b24a697c0`，装配后 `19b465300d07d06d8fbb94678a3353ad6b77c4ec6a8f39379aeb3c4270d324a5`。

## 视觉范围与评分

遵循最新用户要求，只有深色1920×1080，两轮实际截图均已查看。对标 Three 原始材料公式及 Unity 的 PBR/ACES 管线语义；本轮是诊断场景，未评估完整产品场景氛围。

| 维度 | 本轮评分/范围 |
|---|---|
| 布局构图 | 9：八组双栏完整，无遮挡/裁切 |
| 令牌一致性 | 9：base.css深色文字/背景；材料颜色为测试输入 |
| 排版 | 9：标题、配置、原始/公共因子关系清晰 |
| 交互状态完备 | 不适用：静态读回检视，产品交互未改 |
| 动效质量 | 不适用：无动画改动 |
| 3D渲染质量 | 9：真实光照/粗糙度分区/金属/自发光保留，16帧逐字节一致 |
| 信息设计 | 9：材质、视角、输出色彩空间并排对照 |
| 反馈即时性 | 不适用：未测试交互/性能 |
| 响应式与主题 | 9：按用户要求仅深色1080 |
| 语义与文案 | 9：公式共享与完整BRDF边界明确 |

同族排查覆盖两F_Schlick overload、Standard/Physical/clearcoat消费、主线程/worker创建接缝及已有hook拒绝。真实offscreen worker运行、全部材料扩展/用户shader作者、IBL/完整灯光场景、BRDF整体统一和性能测量留后继；WGSL/Native灯光源未变，本轮无需Cargo或sync重跑。
