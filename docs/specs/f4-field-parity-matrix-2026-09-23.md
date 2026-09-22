# F4 逐字段对拍证据矩阵（属性面板 → 快照 → 运行包 → Web/Native 渲染）

> 日期：2026-09-23。对应 handoff `docs/handoffs/deep-monkey-remaining-work-handoff-2026-09-22.md` "### F4"
> 的完成证据要求：**属性面板→快照→运行包→Web/Native 渲染的逐字段对拍，旧包兼容，失败不静默丢字段。**
> 本文是证据矩阵本体；每个格子给出证据指针（文件路径或测试名）。除特别标注外，行号以
> 2026-09-23 工作树（本轮修复后）为准。

## 0. 对拍口径

链路五段：

| 段 | 含义 | 判定方式 |
|---|---|---|
| A 作者合同 | 属性面板可编辑、`packages/contracts/src/scene.ts` 有字段 | 合同字段清单 |
| S 快照保留 | `SceneSnapshot` 保存/恢复不剥离该字段 | `sceneCompilationSource.ts`（源快照整体进 hash，不删字段） |
| C 编译携带 | 运行包载荷携带，且 `evidence.compiledSceneFields` 声明 capability | `apps/web/src/delivery/compileScene*.ts` + evidence |
| W Web 消费 | Studio 编辑器 / Deep WebGPU 运行时真实进入画面 | viewer / postProcessingRuntime 指针 |
| N Native 消费 | Native 渲染端真实进入画面：**真消费 / 降级（degraded 声明）/ 阻断（fail-closed）** | renderer / wgsl / 门禁报告 |

格子标记：

- ✓ = 该段真实消费/携带（有证据指针）。
- 🔶 = 显式降级：字段不进包或进包不消费，但发布门禁给出 `degraded` 条目（manifest
  `degradedCapabilities`，见 `nativeSceneClientPayload.ts:29`），**不算静默**。
- ⛔ = 显式阻断：编译 fail-closed 或门禁 `blocked`，发布被拦下（**不算静默**）。
- – = 该段无此字段语义（如编辑器辅助设施、元数据）。
- ❗ = 本轮（2026-09-23）修复前为**静默丢失**，修复后转为 ✓ / 🔶 / ⛔。见第 7 节。

"静默丢失"判据（handoff 缺陷类）：**编译侧声明了能力或接受了字段，但消费端不消费、
且门禁无 degraded/blocked 声明**。三条路线都排除：既不在 `deferredSceneFields`、也无
degraded/blocked 条目、载荷里也没有对应消费。

## 1. 链路总览（编译管线与证据面）

```
SceneSnapshot（快照保存，scene.ts 合同，schemaVersion 1）
  └─ compileSceneRuntimePackage（apps/web/src/delivery/compileSceneRuntimePackage.ts）
       ├─ compileSceneCamera          → deep.scene.camera.v1（含 constraints/views/clipping）
       ├─ compileSceneEnvironment     → deep.scene.solid-environment.v1（v1–v5/v7/v8/v9 档）
       │    ├─ compileSceneLighting   → directional/multi-light/spot-shadow/point-shadow capability
       │    ├─ compileSceneWeatherFog → v7+ 作者雾（exp2）
       │    └─ compileAuthorColorGrading → v9 档 colorGrading 六通道【本轮接通】
       ├─ compileSceneHdrEnvironment  → deep.scene.hdr-environment.v1（v6 档，prefiltered IBL）
       ├─ compileSceneRenderPacket    → 几何/材质/实例/纹理（材质槽静态子集）
       │    └─ compileSceneAuxiliaryGrid → 环境网格 → Native 绘制数据
       ├─ compileDynamicRuntime       → 动画控制器 / 物理
       └─ evidence: compiledSceneFields（capability 声明）+ deferredSceneFields（未编译域）
            └─ assessCompiledScenePublication（scenePublicationCompatibility.ts，发布门禁）
                 └─ manifest.degradedCapabilities（nativeSceneClientPayload.ts:29，隐藏入口依据）
```

运行包二道把关：Web `validateRuntimeEnvironment`（`packages/deep-engine/src/runtimePackage/environment.ts`，
`deny-unknown` 字段闭合）与 Native `solid_environment::decode`（`deny_unknown_fields` +
档位门）逐档对齐；旧档（v1–v8）合同逐位不变。

## 2. 域 A：全局光照与灯（`SceneLightingState` / `SceneLightState`）

编译入口 `apps/web/src/delivery/compileSceneLighting.ts`；载荷合同
`packages/deep-engine/src/runtimePackage/environmentTypes.ts`（`RuntimeAuthoredLighting`/`RuntimeLocalLight`）；
Native 解码与帧 ABI `packages/deep-engine-native/src/scene_lighting.rs`、`local_lighting.rs`；
IES `packages/deep-engine-native/src/light_profiles.rs` + Web `runtimePackage/lightProfiles.ts`。

| 字段 | A | S | C | W | N | 证据与备注 |
|---|---|---|---|---|---|---|
| lighting.enabled / intensity | ✓ | ✓ | ✓ | ✓ | ✓ | 编译为 radiance 乘数与 exposure 公式 `0.72+0.33·i ∈ [0.55,1.55]`（compileSceneLighting.ts:35）；Native `frame[14]=[exposure,shadows,..]`（scene_lighting.rs:70）。测试 `compileSceneEnvironment.test.ts:"compiles the built-in studio IBL…"` |
| shadowsEnabled | ✓ | ✓ | ✓ | ✓ | ✓ | 决定 casters 集合与 `lighting.shadows`；Native 阴影管线开关。 |
| reflectionsEnabled / globalIlluminationEnabled | ✓ | ✓ | ✓（门控） | ✓ | ✓（门控） | 仅 builtin-ibl（studio）允许 true，false 时必须显式 false，否则整域不编译（compileSceneLighting.ts:13）→ deferred ⛔。反射由 IBL specular 承载。 |
| globalIlluminationIntensity | ✓ | ✓ | ✓ | ✓ | ✓ | 载荷 `lighting.globalIlluminationIntensity`；Native 写 `frame[FRAME_FOG_PROJECTION_ROW][3]`（scene_lighting.rs:52）供探针 GI 混合。测试 `compileSceneEnvironment.test.ts:"keeps authored GI intensity…"` |
| lights[].type directional/point/spot/hemisphere | ✓ | ✓ | ✓ | ✓ | ✓ | v2–v5 档阶梯（v4=spot 阴影、v5=点光阴影，预算 1 点+4 聚）；Native 档位门同阶梯（solid_environment.rs decode `(2..=5,…)`）。 |
| lights[].type ambient/rectArea | ✓ | ✓ | ⛔ | ✓ | ⛔ | compileLight 仅接受四类（compileSceneLighting.ts:52 `else return`）→ 整域 lighting 不编译 → deferred → 门禁 blocked（显式）。width/height（rectArea 参数）随之留在快照。 |
| lights[].color/intensity/enabled | ✓ | ✓ | ✓ | ✓ | ✓ | sRGB→线性 radiance 逐灯换算（compileSceneLighting.ts:68）。 |
| lights[].position/target | ✓ | ✓ | ✓ | ✓ | ✓ | 派生 direction/innerCos/outerCos（compileSceneLighting.ts:59-83）；发布坐标经 `localizeSceneCoordinates` 局部化。 |
| lights[].distance/decay（point/spot） | ✓ | ✓ | ✓ | ✓ | ✓ | → `range/decay`（compileSceneLighting.ts:61，上限 1e6/4）；Native `LocalLight` 同名字段校验（local_lighting.rs）。 |
| lights[].angle/penumbra（spot） | ✓ | ✓ | ✓ | ✓ | ✓ | → `innerCos/outerCos`；锥角退化（outerCos≤0.001 或 ≥0.999999）阻断（compileSceneLighting.ts:32）。 |
| lights[].groundColor（hemisphere） | ✓ | ✓ | ✓ | ✓ | ✓ | → `groundRadiance`（compileSceneLighting.ts:71-76）。 |
| lights[].castShadow | ✓ | ✓ | ✓ | ✓ | ✓ | spot→v4、point→v5 档；Native `local_shadow::matrices` 写帧（scene_lighting.rs:81-101）。 |
| lights[].shadowSoftness（spot PCSS） | ✓ | ✓ | ✓❗ | ✓ | 🔶❗ | 载荷携带（v3–v5 允许）+ Native 解码合法 + CPU 写入 ABI 行 120（scene_lighting.rs:65-66），但 **wgsl 无 softness 消费**（`assets/shaders/native_mesh_v1.wgsl` 无 softness）→ 修复前静默；修复后门禁 degraded（scenePublicationCompatibility.ts `hasAuthoredSpotSoftness` 分支，reason="Deep Native 尚未实现作者 PCSS 阴影柔化参数消费"）。测试 `compileSceneEnvironment.test.ts:"marks compiled spot PCSS softness as degraded…"`。**边界：真消费（PCSS 采样）仍是后续切片。** |
| lights[].ies{profileId,rotationDeg,scaleFactor} + lighting.lightProfiles[] | ✓ | ✓ | ✓ | ✓ | ✓ | LM-63 量化表随载荷；引用闭合双端校验（Web `validateLightingIes`，Native `validate_ies_closure` scene_lighting.rs:229）。 |
| 非 sunny 天气下的灯光 | ✓ | ✓ | ⛔ | ✓ | ⛔ | compileSceneLighting.ts:8 显式拒绝（weather≠sunny 整域不编译）→ deferred。**合同事实：雾天灯光与雾不同包**（作者面板在雨雾天调灯在发布中显式阻断，非静默）。 |

## 3. 域 B：后处理与作者色彩分级（`ScenePostProcessingState`）

编译入口 `compileSceneEnvironment.ts`（v9 分支）；Web 消费
`apps/web/src/viewer/postProcessingRuntime.ts` + `studioDeepColorEffects.ts`；
Native 消费 `author_grading.rs`（CPU 镜像）→ `output_pass.rs`（3×vec4 uniform）→
`assets/shaders/native_output_v1.wgsl`（`author_grading_apply`，ACES 之前 HDR 线性域）。

| 字段 | A | S | C | W | N | 证据与备注 |
|---|---|---|---|---|---|---|
| colorGrading + hue/saturation/brightness/contrast | ✓ | ✓ | ✓❗ | ✓ | ✓❗ | **修复前：编译端从不生成 colorGrading 载荷（TS 合同最高 v8），Native decode/渲染端 v9 全部就绪——链路在"快照→运行包"断开，作者分级发布后丢失**。修复：非中性六通道 → v9 档（schemaVersion 9 / `native-aces-grading-v9` / `colorGrading` 载荷），recipe `deep-scene-static-compile-v14`；evidence 声明 `deep.scene.author-grading.v1`；门禁部分编译语义（postProcessing 一条 author-grading 能力条 + 一条域内其余 degraded 条）。六通道范围三方一致：面板 `ScenePostProcessingEditor.tsx:252-258`（hue ±180、余 ±1）= Native `AuthorGrading::new`（author_grading.rs:63-64）= Web 校验器（environment.ts v9 块）。测试：`solidEnvironment.test.ts:"v9 requires the six-channel…"`、`compileSceneEnvironment.test.ts:"lowers non-neutral author grading…"`、`scenePublicationCompatibility.test.ts:"compiles non-neutral author color grading…"`。 |
| temperature/tint（白平衡两通道） | ✓ | ✓ | ✓❗ | ✓ | ✓❗ | 同上，作为 v9 可选通道（缺省 0 = 精确中性）；Native `AuthorColorGrading` `#[serde(default)]`（solid_environment.rs:151-154）。 |
| 中性输入（开关关/全零） | ✓ | ✓ | –（旧档） | ✓ | ✓ | 不升级档位，v1–v8 包字节逐位不变（compileAuthorColorGrading 返回 undefined）。测试 `compileSceneEnvironment.test.ts:"keeps neutral grading on legacy profiles…"`；Native 中性恒等 `author_grading.rs` 零成本路径 + `renderer/init.rs:271-274` `is_neutral()` 过滤。 |
| 非法分级数值（越界/非有限） | – | ✓ | ⛔❗ | ✓ | ⛔ | 编译器退回旧档且 postProcessing 留 deferred → 门禁显式声明（修复前无任何提示地丢弃）。测试同上 `"keeps neutral grading…"`。 |
| smaa/fxaa | ✓ | ✓ | 🔶 | ✓ | 🔶 | 不编译；非默认整域 deferred → OPTIONAL_OMITTED → degraded（scenePublicationCompatibility.ts:16 `OPTIONAL_OMITTED_SCENE_FIELDS`）。 |
| ssao/ssaoIntensity/gtao/gtaoIntensity | ✓ | ✓ | 🔶 | ✓ | 🔶 | 同上（Native 无 SSAO/GTAO pass；域级 degraded 声明）。 |
| screenSpaceReflection/ssrSteps/ssrThickness/ssrMaxDistance | ✓ | ✓ | 🔶 | ✓ | 🔶 | 同上；门禁专项 reason "Deep Native 尚未实现 SSR 深度/法线/HDR 合成消费"（scenePublicationCompatibility.ts:209-211 附近）。TS 合同注释"Other clients must report unsupported instead of dropping it"由该条履行。 |
| bloom/bloomStrength/bloomThreshold | ✓ | ✓ | 🔶 | ✓ | 🔶 | Native `bloom_pass.rs` 存在的是引擎内部泛光（studio 内建 IBL 场景），**不读作者 bloom 参数**——参数不编译，域级 degraded。 |
| outline/outlineStrength | ✓ | ✓ | 部分✓ | ✓ | 部分✓ | 对象级 outline → `instance.outline` 进包（compileSceneRenderPacket.ts:110）+ Native `outline_pass`（测试 `scenePublicationCompatibility.test.ts:"does not reclassify a compiled object outline…"`）；后处理域的 outline 强度参数不编译（degraded）。 |
| depthOfField/focusDistance/aperture/maxBlur | ✓ | ✓ | 🔶 | ✓ | 🔶 | 域级 degraded。 |
| vignette/vignetteDarkness、filmGrain/filmGrainIntensity、afterimage/afterimageDamp | ✓ | ✓ | 🔶 | ✓ | 🔶 | 域级 degraded。 |
| HDR（v6）档下的色彩分级 | ✓ | ✓ | 🔶 | ✓ | 🔶 | v6 档本轮不携带分级（`compileSceneHdrEnvironment.ts` 不传 postProcessing）；场景分级非中性时门禁 reason "当前编译档未携带作者色彩分级（如 HDR v6 档）…"（degraded，显式）。**边界：HDR+分级同包是后续档位工作。** |

## 4. 域 C：雾与天气（`weather` + `sceneWeatherFog` 合同）

编译入口 `compileSceneEnvironment.ts`（`compileSceneWeatherFog`）；合同
`packages/contracts/src/sceneWeatherFog.ts`；Native `fog.rs`（`FogSettings::authored_exp2`）+
`solid_environment.rs` `AuthorFog`（deny-unknown，密度 [0,8]、线性 RGB [0,64] fail-fast）。

| 字段 | A | S | C | W | N | 证据与备注 |
|---|---|---|---|---|---|---|
| weather = sunny | ✓ | ✓ | –（基线） | ✓ | ✓ | 无雾基线，允许灯光编译。 |
| weather = cloudy / fog | ✓ | ✓ | ✓ | ✓ | ✓ | → v7 档（studio 下并入 v8）exp2 雾：`colorLinearRgb`（sRGB→线性）、`density`（compileSceneEnvironment.ts:39-47）；v7 档雾必填 fail-closed（environment.ts "v7 requires author fog"；Native `(7,_)` 档位门）。测试 `solidEnvironment.test.ts:"v7 requires a valid author fog…"`、`compileSceneEnvironment.test.ts:"compiles particle-free weathers…"`。 |
| weather = rain / snow / storm | ✓ | ✓ | 🔶 | ✓ | 🔶 | 粒子系统无法离线编译：整档不编译雾，weather 留 deferred → degraded（OPTIONAL_OMITTED + 编译器注释 compileSceneRuntimePackage.ts:213-215"weather 字段只被部分消费…必须继续保留在 deferred 列表"）。 |
| 雾的其余语义（曝光因子等） | – | ✓ | 🔶 | ✓ | 🔶 | 同上 deferred 注释明确"粒子/曝光因子未接"。 |
| v9+雾组合 | ✓ | ✓ | ✓ | ✓ | ✓ | 分级档与雾同包（v9 fog 可选，Native `(9,…)` 档位门 + Web v9 校验 optional fog）。测试 `solidEnvironment.test.ts:"v9 requires…"`、Native `grading_profile_admits_plain_no_ibl_kind_and_rejects_unknown_kinds`。 |

## 5. 域 D：环境（`SceneEnvironmentState`）

| 字段 | A | S | C | W | N | 证据与备注 |
|---|---|---|---|---|---|---|
| backgroundColor | ✓ | ✓ | ✓ | ✓ | ✓ | → `backgroundSrgb`；Native `inverse_output` 抵消固定 ACES（solid_environment.rs:319-328，逐字节往返测试 `background_round_trips_fixed_output_for_all_byte_values`）。 |
| skybox = none / studio | ✓ | ✓ | ✓ | ✓ | ✓ | studio → builtin IBL（v8/v9，`solid-background-builtin-ibl`）；none → no-ibl。 |
| skybox = bright-studio/clear/overcast/dawn/sunset/night/industrial-night | ✓ | ✓ | ⛔ | ✓ | ⛔ | compileSceneEnvironment 白名单外 → 环境不编译 → deferred → 门禁 blocked（显式；测试 `"keeps unsupported author semantics blocked: { skybox: 'day' }"`）。 |
| gridVisible | ✓ | ✓ | ✓ | –（编辑器辅助） | ✓ | 编译为辅助网格几何/实例（compileSceneAuxiliaryGrid → render packet），Native 按普通绘制数据渲染。测试 `"keeps auxiliary-grid visibility independent from the skybox…"`。 |
| environmentMapUrl | ✓ | ✓ | ✓ | ✓ | ✓ | → HDR v6 链（`compileSceneHdrEnvironment` + `RuntimePrefilteredIbl`，recipe v11）；资源身份 bytes+sha256 绑定（compileSceneRuntimePackage.ts:174-176）。 |
| environmentMapName | ✓ | ✓ | – | – | – | 非活动元数据：空串中性省略、非空不参与载荷（测试固定 `"does not infer GI off from none…"`，设计决定非丢失——仅是资源显示名）。 |
| environmentAsBackground | ✓ | ✓ | ⛔/– | ✓ | – | HDR 链 true → fail-closed 拒绝（compileSceneHdrEnvironment.ts:9，显式）；solid 链无贴图背景语义可承载（skybox 仅 none/studio），忽略为无语义（测试固定）。 |
| environmentIntensity | ✓ | ✓ | ⛔❗/– | ✓ | ⛔❗ | **修复前：HDR 链校验 [0,64] 却把值丢弃（v6 载荷无强度字段）→ 作者环境强度发布后静默回 1**。修复：HDR 链非 1（含 undefined 之外任何值）fail-closed 拒绝编译 → environment deferred → 门禁 blocked（显式）。测试 `compileSceneHdrEnvironment.test.ts:"fails closed on non-default environment intensity…"`。solid 链该字段无消费对象（无 IBL 可缩放）= inactive metadata（测试 `"does not infer GI off from none…"` 固定）。**边界：把强度真正编进 IBL 载荷需要新档位（v10/IoR），未在本切片。** |

## 6. 域 E：材质槽与对象外观（`SceneMaterialState` / `SceneModelEffectsState`）

编译入口 `compileSceneRenderPacket.ts` + `sceneMaterialOverrides.ts`（静态标量展开到
RenderPacket 材质）；中性判定 `sceneNeutralAppearance.ts`；Native 材质消费
`runtime_package/render_packet.rs`（字段闭合）+ renderer 材质 uniform（`material_uniform_fastpath_gpu_tests.rs`、
`material_resource_diff.rs`、`hdr_material_tests.rs`）。

| 字段 | A | S | C | W | N | 证据与备注 |
|---|---|---|---|---|---|---|
| color（实例覆盖）→ baseColor | ✓ | ✓ | ✓ | ✓ | ✓ | `applySourceMaterialOverrides` 线性化写 baseColor（sceneMaterialOverrides.ts:39）。 |
| roughness / metalness→metallic / ior | ✓ | ✓ | ✓ | ✓ | ✓ | 同上 :40-41；ior ∈ [1,∞) 有限校验；Native 材质 uniform/diff 消费（material_resource_diff.rs:64）。 |
| emissive→emissiveFactor / emissiveIntensity→emissiveStrength | ✓ | ✓ | ✓ | ✓ | ✓ | sceneMaterialOverrides.ts:42-43（上限 10）；Native `normalize_emissive`（render_packet.rs:113-145）。 |
| doubleSided / normalScale | ✓ | ✓ | ✓ | ✓ | ✓ | sceneMaterialOverrides.ts:38,44（normalScale 上限 4，仅源有 normalTexture 时生效）。 |
| sourceColor / sourceEmissive（glTF 源恢复） | ✓ | ✓ | ✓ | ✓ | ✓ | sceneMaterialOverrides.ts:30,39,42。 |
| slotOverrides（gltf:N 实例材质槽） | ✓ | ✓ | ✓ | ✓ | ✓ | 逐槽展开到实例材质（applySourceMaterialOverrides :61-65）；槽引用闭合 `assertMaterialSlotsResolve`（:66-71，不存在的槽抛错）。 |
| baseColor/normal/emissive/ao/roughness/metalness 贴图（Url/Name） | ✓ | ✓ | ⛔（非中性） | ✓ | ⛔ | 静态编译不重写贴图：非空贴图字段 → `assertStaticMaterialOverrides` 抛错"扩展外观需要模型适配"（sceneMaterialOverrides.ts:19-21）→ 发布显式失败（fail-closed，非静默）。 |
| hue/saturation/brightness/contrast（材质实例级校正） | ✓ | ✓ | ⛔（非中性） | ✓ | ⛔ | 同上（中性 0 可省略，isNeutralMaterialField）。 |
| textureRepeat(X/Y)/textureOffset(X/Y)/textureRotation | ✓ | ✓ | ⛔（非中性） | ✓ | ⛔ | 同上（默认 1/1/1、0/0/0 可省略）。 |
| uvAnimation / screen（屏幕映射）/ shaderEffect / wireframe | ✓ | ✓ | ⛔（激活时） | ✓ | ⛔ | 激活即抛错阻断（sceneMaterialOverrides.ts:19 + isNeutralMaterialField 仅放行 enabled:false）；**运行包路线不支持这些字段时显式失败**，不做静默简化。 |
| 对象特效 glow / edgeLight | ✓ | ✓ | ✓ | ✓ | ✓ | 投影到 HDR emissive（staticSceneEffectEmissive，sceneNeutralAppearance.ts:32-41），随 Bloom 出光晕。 |
| 对象特效 outline | ✓ | ✓ | ✓ | ✓ | ✓ | → `instance.outline`（compileSceneRenderPacket.ts:110）；Native outline_pass。 |
| 对象特效 xray/scanline/heatmap/dissolve/fire | ✓ | ✓ | ⛔ | ✓ | ⛔ | `unsupportedStaticSceneEffectFields` → assertStaticModel 抛错（compileSceneRenderPacket.ts:121-134），字段名列进错误信息（fail-closed）。 |

## 7. 域 F：烘焙与 GI（B6 静态贴图 / F3 探针）

| 字段 | A | S | C | W | N | 证据与备注 |
|---|---|---|---|---|---|---|
| staticLightmap（B6 描述符） | –（由烘焙器产出） | ✓ | ✓ | ✓ | ✓ | `lightmapBaker`（bimStudioLightmap extras）→ `staticLightmapDescriptorFromExtras`（staticLightmapAdapter.ts:44-71，textureHash 对账）→ 载荷 `environment.staticLightmap`；Web 校验 `validateRuntimeStaticLightmapBinding`（environment.ts:140-163）；Native `validate_static_lightmap`（solid_environment.rs:37-111）+ occlusion/emissive 语义纹理渲染。 |
| irradianceProbes（F3，单层/级联） | –（烘焙器产出） | ✓ | ✓ | ✓ | ✓ | `compileSceneIrradianceProbes`（compileSceneRuntimePackage.ts:269-311，Native 打包器对账）→ `decode_probe_grid`（solid_environment.rs:588-798，级联嵌套 fail-closed）。capability `deep.scene.probe-grid.v1`。 |

## 8. 本轮修复清单（静默丢失 → 显式）

| # | 字段 | 修复前行为 | 修复后行为 | 改动 |
|---|---|---|---|---|
| 1 | postProcessing.colorGrading 六通道（hue/saturation/brightness/contrast/temperature/tint） | TS 编译器从不生成 colorGrading（合同最高 v8）；Native v9 decode/渲染早已就绪。作者分级发布后整域降级，门禁 reason 还错误声称"Deep Native 尚未实现…消费"（与 Native 实际能力相反）。 | 非中性分级随 v9 档进运行包（recipe v14，capability `deep.scene.author-grading.v1`）；Web 校验器/Native 档位门同步（v9 双 kind：no-ibl + builtin-ibl）；门禁改部分编译语义（分级能力条 + 域内其余 degraded 条），过时 reason 文本删除。 | environmentTypes.ts（合同+类型）、environment.ts（v9 校验）、compileSceneEnvironment.ts（v9 编译）、compileSceneRuntimePackage.ts（接线/recipe/evidence）、scenePublicationCompatibility.ts（门禁）、solid_environment.rs（no-ibl 档位门） |
| 2 | lights[].shadowSoftness（spot PCSS 柔化） | 载荷携带 + Native 解码合法 + CPU 写 ABI 行 120，但 wgsl 无消费——柔化参数发布后静默失效，门禁仅在 lighting 整域 deferred 时才提示（已编译场景无任何标记）。 | 门禁在 lighting **已编译**且存在开启柔化的投射 spot 时输出 `degraded` 条目（reason：PCSS 未消费，仅 Studio Deep WebGPU 生效）；经 `nativeSceneClientPayload.ts:29` 自动进 `degradedCapabilities` manifest。真消费（PCSS 采样）留待后续切片。 | scenePublicationCompatibility.ts（`hasAuthoredSpotSoftness` + compiled 循环 degraded 分支） |
| 3 | environment.environmentIntensity（HDR 链） | HDR 链校验 [0,64] 后把值丢弃（v6 载荷无强度字段），作者非默认环境强度发布后静默回 1。 | 非 1 一律 fail-closed 拒绝 HDR 编译 → environment deferred → 门禁 blocked（显式，"失败不静默丢字段"）。真强度编译需新档位，未在本切片。 | compileSceneHdrEnvironment.ts |

**修复后静默丢失字段数：0**（本轮对拍范围内）。边界保留：shadowSoftness 的 Native 真消费、
HDR v6 档携带分级、environmentIntensity 进载荷、材质槽贴图/UV 动画/屏幕映射的运行包支持——
均已显式降级或阻断，不再静默。

## 9. 测试与门禁证据

| 层 | 测试 | 覆盖 |
|---|---|---|
| TS 合同/校验 | `packages/deep-engine/src/runtimePackage/solidEnvironment.test.ts` "v9 requires the six-channel author grading…" | v9 双 kind、六通道范围、旧档拒绝、fog/lighting 可选 |
| TS 编译 | `apps/web/src/delivery/compileSceneEnvironment.test.ts` "lowers non-neutral author grading…"、"combines author grading with weather fog or lighting…"、"keeps neutral grading…"、"marks compiled spot PCSS softness…" | v9 编译（plain/studio/雾/灯）、中性旧档字节不变、非法退档、PCSS degraded |
| TS 编译（HDR） | `apps/web/src/delivery/compileSceneHdrEnvironment.test.ts` "fails closed on non-default environment intensity…" | HDR 强度 fail-closed |
| 门禁 | `apps/web/src/delivery/scenePublicationCompatibility.test.ts` "compiles non-neutral author color grading…" | 部分编译语义、degraded 文案、recipe v14 |
| Native | `packages/deep-engine-native/src/runtime_package/solid_environment.rs` `grading_profile_admits_plain_no_ibl_kind_and_rejects_unknown_kinds` 等 14 例 | v9 no-ibl 解码、kind fail-closed、旧包拒绝 |

门禁数字（2026-09-23 本轮）：apps/web `src/delivery` vitest 762 passed / 0 failed；
双端 typecheck 与 cargo lib/bin 结果见台账同日条目。

## 10. 诚实边界

1. **本矩阵是静态代码/测试证据对拍，不含 Native 窗口实机截图对色**。`deep.scene.author-grading.v1`
   在发布门禁中仍为"编译完成，等待 Native 运行证据"（blocked，与全部 capability 同纪律）；
   正式发布候选需要按既有流程补 `PublicationCapabilityEvidence`（native-window）。
2. Native 的 AuthorGrading 数值与 Web 的逐位/容差对拍由既有 `author_grading.rs` 测试
   （PI 字面量/Rec.709 权重逐式保留）与本轮 wire 合同测试共同承载；本文不重复数值矩阵。
3. 材质槽的贴图类字段（非中性）在运行包路线是**显式抛错阻断**而非编译降级——属性面板在
   Web 编辑器内仍可用，发布时失败信息逐字段列出。这是当前设计，不是本轮引入。
4. `shadowSoftness` 的 ABI 行写入（scene_lighting.rs:65-66）保留未删：它是帧布局合同的一部分，
   删除会动 mesh ABI；消费补齐（PCSS 采样）前由门禁 degraded 声明承担诚实义务。
5. 台账第二十轮指出的"文档漂移"（handoff F4 段旧文字）不在本切片重写范围；本矩阵即最新
   对拍事实，冲突处以本文为准。
