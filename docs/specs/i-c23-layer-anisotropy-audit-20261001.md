# I-C23 活动层各向异性后继核查

## 已准入 coat/metal 两层组合实际验收

2026-10-01 Web 两独立 fresh 共24帧通过：3个完整生产父HDR、8个coat/metal层序与replace/overlay组合、1个零覆盖，每轮12帧。独立CPU复算560个原采样点，最大绝对误差 `.0010351605853062829`，原 `.002` 门保持；层序最小可辨差 `.228515625`，零覆盖与stock完整HDR SHA恒等，资源归零。两轮深色1920×1080均716800可见像素、8色阶，sourceFresh/stable通过，454实际消费/支持源按本批冻结。

证据 `test-output/i-c23-complete-combination-20261001/gpu-run-2026-10-01T13-17-27.518Z/{evidence,independent-cpu-analysis}.json`。首次v1数学已过但视觉仅4色阶，退出1与全部源/bundle保留；v2只改夹具真实point位置/强度，原门、底材、几何和shader不变。主光、IBL、局部光与共同emission同时启用；参考来自独立完整父响应，不拿direct-only CPU API代替生产完整颜色，不宣称逐瓣隔离证明。

此片补Web已准入跨层组合；Native同范围实际结果见下节。未准入瓣、Studio作者层栈与完整I23仍开放。已有单coat/单metal验收复用，不重复计整项关闭。

Native 两独立实际进程共24帧通过，每帧256×256、完整65536 RGB像素按实际完整父响应独立f64混合复算，最大绝对误差 `.0005225038744440802`，原 `.002` 门保持；层序最小差 `.01928711`，零覆盖完整HDR身份成立。两fresh全部12个HDR SHA逐名相同，CPU日志复核通过。Native helper范围为main+IBL+共同emission，local=0，不将Web局部光范围迁移为Native证据。日志 `test-output/jc-i-20261001-i23-native-combinations-r1.log` / `r2.log`，收据 `test-output/i-c23-complete-combination-20261001/native-independent-analysis.json`。

首次编译E0597源于动态资源label传入static标签参数；原失败和旧稿保留，只改固定资源标签，动态label仍用于诊断。amendment叶SHA `33a34f3242c44984f32ed79d4bbcd3ad25aee537e330c8f7f078343485e8b017`。实际test-bin/lib Cargo depfile共672源码/依赖文件已核当前SHA；守卫生成于本次编译后，不追溯宣称运行前全源fresh。生产shader不变，完整I23开放。

## SDK packet 作者消费例

现状核查见 `test-output/i-c23-complete-combination-20261001/AUTHOR-AUDIT.md`：SceneMaterialState/material.set无layered，Three非中性Physical仍明确unsupported；已有公开shader参数与完整RuntimePackage构包/保存链可直接消费。最小新例 `packages/deep-engine/examples/layered-material-authoring.ts` / `.md` 按唯一materialId纯更新已有packet，复用公开build/serialize/parse；不生成几何、不加作者合同/UI/shader。SceneSnapshot/Three作者体验与整I23不据此关闭。

根路审阅后补保留原 `layered.base`：示例设置两层、替换旧层行而非append；非默认base IOR1.6 sentinel逐值/对象身份与原packet不变的必要CPU回归通过。原公开整包build/serialize/parse、类型与身份检查已过，不重复159源消费矩阵。

## Native 已准入两层组合入口现状核查

1. 全仓Native/tests与未跟踪检索确认唯一bin挂载white_furnace父模块已有coat/metal独立GPU叶；wall_packet/furnace_frame/render_material_frame/hash可复用。
2. 真实typed/serde和validate_packet已有两层coat/metal准入，SDK/Web已通过；同metal层无coat/transmission/MR纹理，304B不变。
3. 固定wgpu/serde与父frame/readback已有，不增依赖；Cargo/GPU由root执行。
4. 新leaf只调用现生产shader组装/上传/opaque/readback helper，不改mesh或shader，父仅path/mod挂载。
5. 旧单coat/metal与Web新24帧不重跑；Native3完整父+8组合+1zero，共12render/fresh，使用既有256全65536像素和原.002，完整zero身份。
6. I23 owner/白炉/clearcoat/金属与作者核查已读。核查时Native此新组合尚无实际结果；现两独立fresh结果见上节。局部光helper为0，明确main+IBL+共同emission完整父范围，不计整个I23关闭。

已有（不重建）：真实生产素材打包/层shader/全帧HDR回读与设备错误门。真实缺口：允许的跨层组合Native两独立fresh完整父响应证据。新文件 `renderer/layered_combination_gpu_tests.rs`，父 `white_furnace_gpu_tests.rs` 仅挂载。正式实现/冻结后根路串行编译与显式ignored测试，不拓展瓣或矩阵。

## 正式集成与验收（2026-10-01 20:08）

显式 `microfacet-metal-reflection` 主光模型已按冻结 SHA 分组提升。root 正式 CPU112/112 与 SDK 完整类型检查通过。Web 两 fresh 每轮26帧/16变换强度组合，最大闭式差 .0002405517345959174，alpha 混合差 .00007994408700978672；Native 两 fresh 每轮16组合，最大差 .0002440883092810764。均保留原 HDR .002 门，身份分支差0，资源归零。

首次实际 Web 运行暴露夹具几何 ID/revision、纹理 ID/revision和主光 ray 方向问题，失败日志保留；仅修夹具身份与方向后重跑通过。runner 源哈希范围补入实际新帧 helper；root 独立核对1695消费源。旧 coat 两端 before/after 各两 fresh 全部 HDR SHA 相同，Web7帧逐名比较、Native4进程独立对账；见 ignored `jc-i-20261001-i23-web-before-after-verified.json`、`jc-i-20261001-i23-native-before-after-verified.json`。

本片通过，停止同源重复验证。完整 I23 的非金属各向异性、透射、扩展组合、作者层栈与完整分层白炉仍开放，不将主光金属范围计作整项关闭。

本片先核查活动层anisotropy的真实主光消费与能量边界。正式源保持冻结，CPU证据与草稿留ignored `test-output/i-c23-layer-anisotropy-20261001/`。I-C23整项不因单瓣通过关闭。

## 现状核查

1. 全仓packages/contracts/src、deep-engine/src、Native src/assets/shaders及apps/web/src搜索layered/anisotropy/params0/params1/tangent，含git status未跟踪项。304B和活动清漆叶已正式存在；Native只将params0传wrapper，未读params0.w或params1.x。作者ObjectAppearanceEditor没有层参数消费；已有GLTF扩展保留不同于层编辑体验。
2. 契约已有MaterialParameterOverrides、LayeredSurfaceOverrides、RenderPacket/PbrMaterial、LayerAnisotropyParams。strength为0..1、rotation有限，TS规范化到(-π,π]并转f32；Native直接JSON目前原rotation f32打包。params0=[IOR,coatFactor,coatRoughness,anisoStrength]，params1=[anisoRotation,transmissionFactor,0,0]。不改304B或160B ABI。
3. deep-engine已有Vitest/esbuild/TypeScript；Native固定wgpu30.0.1/serde1.0.228，共享WGSL sync/checksum和naga缓存已在用。无需新运行依赖，不启动Cargo/GPU。
4. Browser实际pbrShader.extendedShade→composeLayeredMaterialSceneShader→deepLayerBaseShade同时消费aniso strength/rotation和真实正交tangent。Nativedeep_layer_stack→native_layer_lit_response→T08 pure core只传coat，contract与SDKguard拒活动aniso。native_vertex负责模型空间tangent变换和正交化，法线贴图可改变着色normal，需要wrapper沿Browser再做正交投影和fallback。普通RT入口保持不静态可达层binding。
5. 活动清漆两fresh Native墙/RT/Web已有真实证据，layer纹理与白炉/RT已有门不重建。既有materialEvaluate.test有aniso旋转/强度测试，但其hemisphereReflectance对已经含nDotL的rgb额外乘cosθ，不能作为此片正确dΩ能量证明。先用实际dist函数与独立闭式、等立体角积分定位，不改期望/容差吸收问题。
6. 已读remaining权威I-C23行、GLM/恢复链和production/native-consumption/material-consumption-next/clearcoat/furnace/RT规格。旧“Native无layered”已被本日生产实现取代；当前真实缺口为活动aniso/transmission、基材扩展正式载荷/消费及作者层编辑体验。此片选择一个活动aniso主方向光切片，不将完整三瓣或编辑器一并展开。

已有（不重建）：层纹理色/MR/alpha/UV、层混合、19纹理资源owner、RT层族、304B params载荷、T08无绑定三瓣数学、现有stock-main替换公式、两端fail-closed。

真实缺口：Native活动aniso参数被明确拒绝且无真实主光求值；其正确半球能量边界尚缺独立证据。

## 最小实现与准入

先验证现T08 D/Schlick-Smith实际语义。若能量边界成立，Native层wrapper补params1传值；仅coat/aniso都0时原样返回stock。非零扩展沿Browser `stock完整响应 − stock主方向光 + T08层主方向光`，IBL/GI/local/emissive保留；base三瓣和层transmission仍拒。zero-strength保留旧stock逐值恒等，既有coat单独开启数学保持。tangent在wrapper按当前normal投影，复用native safe_normalize/tangent_fallback，不新建坐标框架。

最小候选文件锁：Native `assets/shaders/native_layer_extended_v1.wgsl`、`native_mesh_v1.wgsl`层调用；SDK `runtimePackage/renderPacketNativeMaterial.ts`及聚焦测；Native `contract/validate_layered_params.rs`及聚焦测。pbr_layered现已有全部6载荷，仅需如实更新注释；Native直接JSON旋转规范化若实际造成漂移，另列最小修复，不静默改变合同。共享core不改；new leaf≤300。

验证：真实dist evaluateExtendedMaterialDirect对独立anisotropic GGX闭式，strength0与rotation无关、rotationπ周期、tangent旋转与rotation等价；正确dΩ积分含grazing/roughfloor/metal0..1，不用既有双cos辅助。草稿guard实际public builder→materialize，Native真实typed/serde合同；naga raster/RT普通与层entry绑定可达性。GPU提升后由root沿现clearcoat墙/RT/Web两fresh门追加真实旋转/强度矩阵、零分支身份、无主灯辅助响应身份；本路不启动GPU。

## 真缺陷、负控与源冻结

actual finaldist T08与独立各向异性GGX闭式1296组最大归一差1.1649201739722725e-14，rotation实响应差1.2600672929。合同 `materialEvaluate.ts` 明确rgb与每个component已经包含radiance×nDotL；等立体角积分只能再乘dΩ。既有test helper却乘cosθ×sinθ的角面积，重复cosθ，原三文件24测实跑仍绿。

白色dielectric、metal0、roughness.35、view85°、strength1/rotation.4，正确dΩ从64×128到512×1024收敛为1.0117441882605966，末两级差5.84e-6；分解diffuse=.9390358878943769、specular=.07270830036623803。extra-cos负控=.6597521340556565。strength0同核正确1.0069982358121685、负控.650332532643015，证明旧基线也有此域超能量。无容差变更，不把有限格点的归因写成全参数结论。

原CPU/WGSL源完整保留于ignored `materialEvaluate.before.ts.txt` / `materialEvaluateCore.before.wgsl.txt`；未修改正式helper、测试或guard。

## 不透明层界面数学提案

草稿仅是新的opaque界面近似，不全局替换T08/stock/C8或既有清漆；无透射BTDF、Snell折射、内部介质/多散射，也未证明coat组合。aniso D保持ax=alpha×(1+strength)、ay=alpha，遮蔽改为相同ax/ay的height-correlated Smith。漫反射使用对称入/出界面Fresnel透过乘积；这是会改变材质外观的模型选择，不能当旧参数的“数值修正”。旧case变为diffuse=.32137889319963964、specular=.1859207859737273，总.5072996791730142，斜视显著变暗。

Primary source核实：同方向轴的Lambda、height-correlated G2和反射半向量Jacobian来自[PBRT4 §9.6](https://pbr-book.org/4ed/Reflection_Models/Roughness_Using_Microfacet_Theory)。[Burley 2012 §5.3](https://media.disneyanimation.com/uploads/production/publication_asset/48/asset/s2012_pbs_disney_brdf_notes_v3.pdf)讨论入/出两次Fresnel与互易，也指出宏观Fresnel调制在斜视偏暗，Disney另用了roughness相关经验retroreflection。本提案没有宣称等同Disney rough diffuse。[PBRT4 layered material](https://pbr-book.org/4ed/Light_Transport_II_Volume_Rendering/Scattering_from_Layered_Materials)明确通过实际层内路径处理coat与diffuse，本简单乘积不等同完整CoatedDiffuse BSDF。这些来源支持数学组成及限制；草稿组合的能量结果来自本仓独立数值实验。

极角采用代数等价的stable visibility：`0.5/(nl*sqrt(nv²+ax²*tv²+ay²*bv²)+nv*sqrt(nl²+ax²*tl²+ay²*bl²))`，避免单侧nVfloor破坏互易；后方入射/视线返回零。不是对最终颜色clamp。

54组dense等立体角矩阵（metal0/.5/1、rough.35/.7/1、strength0/1、view0/60/85）after最大.9764524988。360组NDF/cos联合PDF矩阵含roughfloor.045/.1/.35/.7/1、metal0/.5/1、strength0/.5/1、rot0/.8、view0/60/85/89，每组32768样本；最高.999995877，30个接近1点以262144精化最高.999995886。有限抽样与诊断误差不能替代全域数学保证。

324组旋转/非均匀缩放/镜像/退化tangent独立分母闭式最大8.33e-17、tangent旋转等价3.89e-16。另324组含nV=1e-7/nL=1e-5极角BRDF互易最大8.42e-16。

反射采样草稿复用正式createReferenceRng，联合PDF为`.5*cos/pi + .5*D(h)*nh/(4*vh)`；完整diffuse+GGX响应除联合PDF。非法NDF反射作为零贡献null事件，不重采样。65536样本63970接受/1566 null，重复seed逐值一致；独立局部密度/Jacobian对PDF差1.78e-15。积分估计[.53754,.44636,.26661]与256×512等立体角参考[.53818,.44688,.26691]在预设6SE+1e-4抽样诊断门内。未接PT产品或新的积分器。

WGSL数学叶58行，复用既有pure helpers/IOR；直接naga解析/全校验已过，globals=0/entrypoints=0，无Cargo/GPU。正式普通/RT层binding reachability仍沿原生产代码，此数学草稿未挂载，不以pure parse当GPU执行。

## 下一实施取舍

旧layer zero-aniso、stock/C8及coat-only需逐值保留。新opaque界面模型要有明确opt-in语义，不能仅把aniso strength从0调到极小正数就静默切换漫反射家族；作者合同与支持域需root审后选择。当前Native guard继续拒活动aniso。与coat组合/其他瓣尚缺能量证明，不能只删guard放行。正式SDK/WGSL/golden必须在模型合同确定后同步消费与独立证明；不能机械重写旧golden。

作者链的真实缺口：contracts SceneMaterialState、ObjectAppearanceEditor没有layered作者字段；compileSceneRenderPacket会保留已解码source材质并应用已有override，但无作者层栈override合同。当前正式层纹理只在SDK packet/lab实际使用。已有颜色/MR纹理资源、UV与响应核不重建；作者需要薄层参数/表面覆盖编辑、SceneSnapshot保存恢复及compiler桥。统一材质合同归属需避免contracts反向依赖deep-engine或再复制参数类型，另由root审核最小文件锁；Three作者viewport的真实层响应呈现也需核查，不能只加表单而把stock preview当层材质效果。

## 审定切片：显式纯金属反射模型

根路审定采用可选 `responseModel: "microfacet-metal-reflection"`，缺省仍为 `legacy`。此选择承认模型差异：旧stock/C8含多散射及D分母下限，新模型为归一化各向异性GGX单散射；仅在旧模型的strength=0分支保持身份、正数换核会产生参数跳变。新模型从strength=0到1e-7/.01/1连续，既有legacy/coat不换核。

活动新模型要求显式metallic=1、无层MR纹理、coat/transmission因子为0；层色/alpha纹理与独立UV沿既有消费。roughness下限.045，ax=roughness²×(1+strength)，ay=roughness²；匹配height-correlated Smith G2、Schlick导体F0=层线性色。无漫反射、折射、清漆或多散射。仅替换主方向光，stock IBL/GI/local/emissive保留。基材三瓣及legacy活动层aniso/transmission继续拒绝。

层旋转在新profile限定到[-f32π,f32π]并将-f32π规范为+f32π，JSON往返保持值；legacy旋转范围不收紧。coverage0保留数值/枚举校验后剪枝。304B版本/144B层行、160B Native、192B材质、224B数组ABI尺寸不变，既有surfaceMode.w空闲bit3（值8）承载显式模型。22float旧标量打包与旧标量direct evaluator无法承载该模型，活动新profile明确拒绝；新增表面感知CPU参考消费同一合同。

共享无绑定WGSL叶与TS生成镜像同源SHA为 `3f61eb3088d23cbf0f18e9ac65db33d32ffdf8373e4fb72acbd970a346a88be3`。Web只在层shader加入location13的变换后metalTangent，默认旧核继续用原varying；普通13/层14个interstage变量低于16上限。Native复用既有实例normal/tangent变换及层wrapper，普通RT不静态可达层资源。

## 冻结提升清单与CPU证据

ignored清单 `test-output/i-c23-layer-anisotropy-20261001/promotion-manifest.json`，SHA `0ed16a1650cfd821a01e48afc37998097c02deea63994419143592883e810ab8`；34个候选、70个只读support上下文。冻结时20个既有候选beforeSHA均匹配当前正式源，含根路最新C8单normal基线；Native startup四叶不在候选中。所有新叶≤300行；supportOnly不提升。此清单尚待根路守卫提升。

CPU实跑结果：

- 11文件113测试通过：112个正式候选测试及1个ignored shader dump诊断；覆盖旧同族87测、新profile25测。SDK完整镜像src typecheck与本片两lab文件的聚焦typecheck通过。
- Native实际typed/serde→validate→pack及旧合同/层行22测通过；实际共享SHA与普通RT可达性16测通过。采用本机缓存rustc/serde/naga，未运行Cargo。
- 独立675组NDF/Lambda响应、互易、strength0/epsilon测试通过；65536样本复用正式RNG，联合NDF/cos PDF，null事件不重采样，独立dΩ参考在预设6SE+1e-4抽样门内。有限矩阵不表示全参数能量证明。
- naga校验实际组装的Native raster/RT普通与层entry、实际Web当前C8 shader+草稿层compose通过；普通入口新增资源不可达。新Native GPU测试叶仅完成真实缓存依赖的rustc metadata类型校验。
- 旧coat Web基线入口node语法及CPU esbuild bundle通过（2186482字节）。未启动浏览器或GPU。

日志均在同ignored目录：`profile-vitest.log`、`profile-typecheck.log`、`profile-lab-typecheck.log`、`native-profile-test.log`、`checksum-profile-test.log`、`naga-profile-test.log`、`naga-browser-test.log`、`gpu-syntax-metadata.log`。

## 新profile GPU测试已准备，尚无实际GPU结果

本路GPU/Cargo/浏览器启动次数均为0。以下入口由根路串行执行后才能更新为实跑结果。测试消费真实packet/生产renderer并读取HDR；准备完成不表示GPU通过。

before诊断组 `native-before-diagnostics` 有3个正式候选：white_furnace_gpu_tests.rs模块seam、layered_clearcoat_gpu_tests.rs既有HDR新增SHA记录、新layered_metal_reflection_gpu_tests.rs ignored测试模块。新profile测试在旧合同也可编译；before仅过滤旧coat，不调用新模型。ignored Web基线入口只对原正式shader/frame增加HDR字节SHA，自己运行两fresh：

```powershell
node test-output/i-c23-layer-anisotropy-20261001/legacy-baseline-web-gate.mjs
cargo test --manifest-path packages/deep-engine-native/Cargo.toml --bin deep-engine-native layered_clearcoat_main_light_matches_closed_response_and_zero_identity -- --ignored --nocapture
```

Native oldcoat需两次独立进程，输出legacy_coat_stock_hdr_sha256与legacy_coat_active_hdr_sha256；SHA格式是half解码后的RGB f32 little-endian。Web保存完整capture HDR字节SHA，两端SHA不能跨格式比较，仅各自before/after比较。

全部生产提升后：

```powershell
$env:C23_GATE_MODE="metal-reflection"
node scripts/i-c23-production-layered-material.mjs
$env:C23_GATE_MODE="clearcoat"
node scripts/i-c23-production-layered-material.mjs
cargo test --manifest-path packages/deep-engine-native/Cargo.toml --bin deep-engine-native layered_metal_reflection_main_light_matches_independent_response_and_transforms -- --ignored --nocapture
```

Native新profile需两次fresh进程；Web入口自含两fresh。矩阵为identity/非均匀旋转/mirror/退化tangent各strength0/1e-7/.01/1共16主光case，独立f64 oracle沿原绝对HDR .002门；另覆真实序列化恢复、色纹理alpha0/128/255、coverage0、无主光辅助响应身份。Web同时生成深色1920截图；旧default/coat各host before/after HDR身份必须独立比较。

I-C23仍未关闭：本片是SDK/Deep显式主光金属反射能力，作者Three/UI无层模型消费；非金属各向异性、扩展组合、透射、作者层栈编辑与完整分层白炉仍是后继。前文不透明双界面草稿仅保留归因与负控，不在此提升范围。

## 根路实跑旧coat before基线

根路已按SHA守卫提升3项诊断，收据 `test-output/jc-i-20261001-i23-native-before-diagnostics-promotion.json`。本路只读确认三源等于冻结afterSHA；其余生产候选此时未提升。

根路运行ignored Webbefore入口，两fresh均通过，sourceFresh=true、errors为空、每轮7张HDR所有逐名SHA一致。`legacy-before-web-gpu/evidence.json`中clearcoat-layer及restored为 `16a484664401dd5c02bf29585cba37d4d071c4adb73554464cfa21d671d7f9ef`，coat-base及coverage0为 `4d7fe49d5589ff5e974e136abf75c4f24667dcbe68f7292dfe4f5e2d995c23a6`，factor0及stock-layer为 `f309d0a6bfb6b9c17f1b6e2d7131726a83e6002ae445b1f626ff352c0dac4847`。主光闭式最大绝对误差.00019033399282719632，coat差.019775390625，factor0/coverage0/restored差0，资源归零。after需比较同host全部7个HDR SHA；新profile扩展会改变shaderHash，不能要求shaderHash与before相同。

此结果属于既有清漆before稳定性，尚无新profile实际GPU结果；Native before和两端newprofile由根路继续串行执行。

## 待跑入口静态复核修复

复核发现Web runner新增mode却未补截图选择：metal-reflection仍寻找不存在的two-layers，会在数学结果通过后强制失败。独立ignored `runner-selector-fix/amendment.json`只将该mode截图选择改为真实metal-texture-alpha-255；既有可见像素>100000、色阶bin>5门和所有legacy模式选择保持。新脚本SHA `b9784cdf41c2de74c216dce38882195cb7addfc9a44dc82285c9aedd14a99c65`，node语法与从实际源抽出选择表达式的before/after回归通过。父manifest及其staged原稿保持冻结，根路提升时须用此单项amendment替代旧脚本afterSHA。

## 根路提升及新 profile 实跑

2026-10-01 根路已提升31项生产候选与3项诊断。首轮 Web 在 geometry vertices 变化但仍复用同 id/revision 时由真实资源守卫拒绝；只修 transformed geometry 派生稳定 id。第二轮在 alpha255→128→0 同纹理 id/revision 倒退时拒绝，同时实际平面黑帧揭示 fixture 把 ray-travel +Z 错当 surfaceToLight +Z。首两轮失败日志保留，执行到16帧不等于数学门通过。

最小 fixture amendment 保留缓存守卫、原 .002 数学门和可见像素/色阶门：ray direction 改 -Z，真实 resolvePbrSceneLighting CPU 断言 surfaceToLightWorld=+Z；各 alpha 使用独立稳定 texture id/revision0，原像素不变。根路按 before 3f49c6c7… / after d5f8b37f… 提升该叶。

根路报告实际 Web 两 fresh 的26帧/16主光 case 全绿，alphaBlendError .000079944、maxClosed .000240552，并独立核验1695源 SHA；Native 两 fresh 16 case 最大误差 .000244088，旧 coat after 两轮 Native HDR hash 均与 before 相同。Web 旧 coat after 两fresh全部7帧 HDR SHA 与 before 相同，根路收据 `jc-i-20261001-i23-web-before-after-verified.json`。I23 原锁定整行仍未关闭，显式金属反射 profile 与完整作者分层材质范围分开登记。

## 表面感知 CPU 层栈参考

新增正式公共 API `evaluateLayeredSurfaceDirect`，复用既有层参数准入、表面覆写、旧直接响应与显式金属响应。旧 scalar evaluator 对金属模型的明确拒绝保持；新入口补齐其指向的表面感知能力，不引新的 shader、ABI 或层语义。六步现状核查与候选记录在 `test-output/i-c23-complete-combination-20261001/AUDIT.md`。

新增6项正式回归覆盖288个 coat/metal 视角、光向、辐射、混合模式及层序组合；逐 lobe 的独立父响应组合、零覆盖身份、完整替换、未解析纹理拒绝、输入不变与无效值准入通过。原37测和公共导出严格类型检查通过，收据 `formal-receipt.json`。该参考仅表达直接响应；IBL、局部光、发光和生产 stock 主光替换不据此宣称通过。GPU真实组合仍待实际消费验证，I23整项保持开放。

root 另修正已有白炉测试的积分测量：求值 `rgb` 已包含入射余弦，半球积分只乘 `sin(theta) dtheta dphi`，移除重复的 `cos(theta)`。原5组层栈、4视角和 `1+1e-3` 门不变，单独实跑该能量项通过，日志 `jc-i-20261001-i23-furnace-cosine-correction.log`。同时纠正旧求值器注释：逐方向凸包界不推出半球积分界；未修改生产混合数学，未由有限采样声称所有层栈能量成立。
