# J2-B5 共享storage核生产适配审计

把已有共享探针storage数学接入Native生产网格采样，保留头记录、nearest旧路径和Web texture语义。此文记录生产适配边界与验证合同，实际结果在后文登记。

## 现状核查

1. 全仓packages/apps src及未跟踪文件已查：canonical probeClipmapSampling.wgsl、Native grid/nearest、Web texture及作者bake发布已存在；当前在途I材质/splat、B6雾文件不改。
2. 契约：IrradianceProbeRecord 96B、ProbeClipmapLevel 64B、Native单层头/v2最多4层、Web ProbeClipmapLightingBinding和texture metadata256B已定义。Native绑定是group0/binding11，Web正式texture是group3/bindings9/10/11，不互换ABI。
3. 依赖：deep-engine已有WebGPU类型/Vitest/esbuild，Native已有wgpu30/pollster/bytemuck/serde_json；不用新GI库、IR、渲染器或benchmark设施。
4. 消费：Native renderer/init解码作者records并生产seed、ProbeGiStorage上传，frame_bindings拼mesh shader，mesh调用probe_gi_irradiance→grid或nearest。probe_gi_wgsl.rs目前仅include/checksum，未进入正式factory。Web PbrRenderer→ProbeClipmapPbrController→ProbeClipmapRuntime/capture adapter提交texture→setProbeClipmap→group3→deepGiSampleTexture已在用。
5. 测试：B5十向量两宿主/生产Native函数、storage GPU、probe_grid_trilinear与two-level实际帧、CPU网格/级联已有；Web texture源码/绑定/T02门存在。本刀不重建或重复上述矩阵，只需新增正式adapter装配与真实texture差异身份/非均匀样本控制。
6. 规格：读j2-b5-probe-production-parity、C8 Native local/geometry/UNLIT与0930任务范围。当前缺口是共享核生产消费，不能将“字节单源”或compute向量等同整个生产GI链。

**已有（不重建）**：烘焙/32方向捕获、重定位、失效调度、级联、三线性、Native实际storage和帧消费、Web事务资源提交。**真实缺口**：Native独立8-corner数学未消费canonical；Web正式texture与storage算法和承载数据有合法差异，不能硬宣称三族等价。

## canonical接口与Native映射

真源`packages/deep-engine/wgsl/probeClipmapSampling.wgsl`已有：

- `deepGiSample(worldPosition:vec3f, worldNormal:vec3f, environmentFallback:vec3f)->vec3f`
- `deepGiSampleLevel(levelIndex:u32, worldPosition:vec3f, worldNormal:vec3f)->DeepGiLevelSample`
- `deepGiVisibility(record:DeepGiProbeRecord,receiver:vec3f,probePosition:vec3f,spacing:f32)->f32`
- `deepGiNormalWeight(probePosition:vec3f,shadingPoint:vec3f,normal:vec3f)->f32`

默认storage为group3 bindings9/10、array<DeepGiProbeRecord>/array<DeepGiLevel>。record为6vec4：irradianceValidity、visibility(meanDistance/variance/floor/padding)、relocation、3保留行。DeepGiLevel为originSpacing、gridSize+level、originCell+baseProbe、maxPosition+probeCount（64B）。

Native group0/binding11是array<vec4f>，每record6行；shader常量PROBE_GI_RECORD_FLOATS=6是vec4行数，Rust同名PROBE_GI_RECORD_FLOATS=12是非保留float字段数，不可混用。header record首3行分别origin/spacing、gridSize/baseProbeRecords、maxPosition/probeCount，后3行保留；旧单层baseProbeRecords=1。v2 record0首3行零，row3=[2,levelCount,1,0]，row4/5零；层头与该层probes逐层排列，baseProbeRecords为绝对记录索引。

最小适配保留Native header解码/层间范围与cursor==recordCount严格校验，将合法ProbeGiLevel转换成canonical DeepGiLevel（originCell可零、level为当前序号、baseProbe取绝对record index）。Native record读取由`probe_gi[index*6+0..5]`构造canonical struct；计数为arrayLength/6。maxPosition按Native原origin+gridSize*spacing保存，不能改成Web metadata的origin+(gridSize-1)*spacing。

首刀只共享真实8-corner数学，不重写header/producer：canonical样本函数经provider接口取得recordCount/loadRecord，并允许合法level值传参；默认group3 storage wrapper继续原入口/原绑定，Native adapter继续group0流。若采用宿主源装配转换，必须从canonical抽取现有函数、精确guard签名/读取接缝，漂移明确拒绝，不能复制公式模板。Native coarse选择、smoothstep混合、非法world/normal返回零和旧nearest保留；不要为抽函数再建IR。

## Native拥有化、生产与staging

renderer/init从PlayerContent.probe_grid_records复制records；decode_probe_grid_cascade/pack_cascade_records保留合法头，ProbeGiStorage::from_packed创建单storage，frame[11].w模式0关/1扁平nearest/2网格。网格positionOffset为relocation增量；nearest则为预烘焙世界位置，不能用grid provider替换nearest扫描。

Native真实manager是Renderer持有ProbeGiStorage/probe_frame_buffer，init装配并在环境替换/RT绑定中复用该buffer；未发现独立逐帧ProbeManager或grid update staging消费者。Web已有独立ClipmapRuntime/Resources的generation、取消/validation staging和capture commit，不能据此说Native已同等动态收敛。

init的native_gi_producer::produce_direct_irradiance对合法cascade的所有valid非header records填统一方向光seed，保留距离/relocation，当前不是多反弹producer。非均匀实际帧验证必须记录init后真实records，或用明确无author lighting入口保留作者bake；不能向测试helper手工绑非均匀records然后声称覆盖了init producer。采样适配本刀不改producer或重建staging。

## Web texture真实消费与差异

真实发布接口`WebGpuProbeCaptureAdapter.commit`返回texture/view/sampler/levelMetadataBuffer及deviceEpoch/generation，`ProbeClipmapPbrController.beginFrame`只发布committed新generation。PbrRenderer.setProbeClipmap→ForwardPlusPbrRuntime.setProbeClipmap→ForwardPlusPbrLightingBindings：9为texture_2d_array<f32>，10 filtering sampler，11为256B uniform；pbrShader真实调用`deepGiSampleTexture(world,n)->vec4f`，alpha控制是否采用probe环境项。

texture每层8次textureLoad，layer=level.level*gridSize.z+cell.z。每texel只有irradiance.rgb+validity.a，没有mean/variance/floor/relocation；三线性coordinate用normal-bias receiver，normal权重仍用worldPosition。storage/Native用worldPosition做三线性，receiver仅进Chebyshev。texture累计权重>0即有效并返回alpha1，storage阈值.001；texture层间线性clamp且mix含alpha，storage/native smoothstep并细层失效粗层兜底。不能把texture输入伪造距离统计后宣布完整等价；测试要按family分别冻结期望并标注差异。

## 共同实帧的真实前提

现tests/support/shader_material_renderer.rs虽复用正式FrameObservation/factory，probe槽始终绑定disabled_frame_buffer，未消费PlayerContent.probe_grid_records。最小测试接缝是在原单bindgroup创建处：有records时经正式decode/pack_cascade_records/ProbeGiStorage取buffer，无records仍96B disabled；测试configure显式写mode2/0。不新增renderer/pipeline，也不需扩FrameObservation字段/重写所有旧调用。已有renderer/probe_gi_gpu_tests手工装配真实帧但要求RayQuery设备，不能将其None返回当actual，后继共同叶应正常请求非RT硬件device。

两family的normal bias都固化`.2`，没有“normalBias0”宿主参数。uniform irradiance、validity1、无relocation、meanDistance很大、采样点远离域边界时，归一后采样值可按数学恒等为该均匀RGB，避开bias坐标差异；不通过修改canonical偏移参数制造共同输入。

完整材质消费仍不同：Web probe替换环境diffuse并乘`(1-specularFraction)*(1-metal)*base*AO*GIscale`；Native保留原环境diffuse，probe额外项为`base*(1-metal)*irradiance*AO/PI`。因此相同probe采样值不等于相同HDR，uniform输入也不能直接宣称整帧同门。当前最小范围为共同采样值等价+两个宿主各自独立期望的真实正增量；要统一完整HDR需root另行冻结产品GI混合合同。纯金属把GI增量归零不能当有贡献控制。

## 建议锁与后继验证

root生产最窄：probe_gi_wgsl provider装配叶、Native frame_bindings宿主组合和mesh原sample-level调用。canonical WGSL/default group3绑定及其镜像/sidecar不改。ProbeGiStorage、renderer/init、frame ABI、nearest和Web capture/runtime/资源绑定先不改。J3线路可追加实际factory/source身份门和少量非均匀正式帧；Web texture矩阵直接复用现PBR接口/已有capture提交，不复制renderer或已有十向量。

本审计未运行Cargo/GPU，未改共享生产文件。最终锁由root按实际实现选择，canonical default bindings/public函数和既有ABI必须保留。

## 实帧首刀（J3专线）

沿上述六步核查复用 FrameObservation 原 bindgroup seam；作者 grid 用正式 pack_cascade_records/ProbeGiStorage，原无records继续96B disabled，不增pipeline或observer字段。实际初始化producer不在此seam范围。

固定原85点、两相机、每profile两draw；非金属0、roughness .8、法线偏移原 .2。合法27探针 origin[-24,-24,-24]/spacing16/gridSize[3,3,3]，validity1、meanDistance100000、variance1、relocation0。三个uniform输入为zero/[.25,.5,1]/[.5,1,2]，采样点位于双方域内且有正半球角权重。

实际Native初跑在pixel6991/0失败：0对期望.06843662，日志`test-output/interrupted-0930/b5-native-actual-frames.log`；原fixture快照`probe-gi-actual/fixture-grid-plane-before.json`保留。原origin[-16]^3让全部85个正Z平面点落在探针z=0格平面，Native world-coordinate三线性所有有权角点都与表面同平面，normal weight=0，正式fallback；Web texture以bias receiver取三线性，仍有正Z角点贡献。这是合法family语义差异。GPU失败后将uniform共同输入移至origin[-24]^3，使原点位于[-8,8]格内部；原85点、bias、irradiance与.001门保持。独立几何CPU admission逐85点分别核对两family正权重，并复用原storage CPU sampler核对正式fallback；原grid-plane保留负控制，不作为共同实帧正贡献输入。

每宿主两fresh device，各12frame；Native runs数组逐run比较并完整hash稳定。源package/packet hash仅固定输入锚点，另保存真实修改后packet/hash、上传packed probe bytes或texture half lanes/metadata bytes及每frame实际uniform。Web明确关闭texture-array/layered与实例变形、固定plain非透明材质，经pipelines.ts原moduleCode选取sceneShader；保存plain/depth/ccw实际编译ledger，stock hash因此对应vertexMain/fragmentMain同module的实际消费。Native身份取真正装配provider的purefactory。

正式prefiltered IBL黑diffuse/specular与恒定DFG[.75,.0625]，IBL启用、无直射/雾/自发光。Native mode0为控制，mode2消费作者grid；Web真实setProbeClipmap/texture绑定zero为控制。CPU期望分别为 Native base*irradiance/PI 与 Web base*irradiance*(1-specularFraction)，其中specularFraction=(.04*.75+.0625)*(1+.04*(1/(.75+.0625)-1))。原85点全比较、alpha1、正增量及两draw/fresh完整hash；绝对half门预注册 .001。两宿主完整HDR公式差异保留，采样值按各自正式混合反解后才比较；不是同HDR对拍，也不覆盖capture producer/staging或非均匀网格。

实际Native两fresh设备共24帧、Web两fresh设备共24帧已通过原独立HDR门；purefactory身份使用 native_mesh_shader_source，不再用静态concat遗漏provider装配。当前Native收据未记录adapter.backend，记为unrecorded；不据其他测试或机器配置推定本次Vulkan/D3D后端。

CPU门：`pnpm exec tsc --noEmit -p tsconfig.lab.json`、`pnpm exec vitest run lab/j2ProbeGiActual.test.ts`（3项，包cwd）、`node --test scripts/lib/j2ProbeGiActualIdentity.test.mjs`（3项，仓cwd）通过。身份门验证实际packet文本/hash、上传字节/hash与冻结profile、所有真实frame参数/hash和实际plain模块装配身份；拒绝缺点、关闭GI、改材质、错误上传或无正贡献。双端采样比较用各宿主独立混合公式反解HDR，binary16相邻可表示端点区间加预定gamma16=`16*2^-23/(1-16*2^-23)`乘法/八角累积f32预算，区间须相交且各自包含原uniform irradiance；不拟合实测阈值。

Native具名命令：`cargo test --test gpu_shader_material_draw j2_b5_actual_probe_gi -- --ignored --nocapture`。统一fresh命令：`node scripts/j2-probe-gi-actual.mjs`（Native具名一次，每宿主两fresh设备）；分段Web命令带`--web-only`，只使用已保存Native两device receipt且currentRun=false；`--compare`仅旧证据诊断。默认失败清本次汇总，原子项日志保留。结果边界仍为uniform/正式帧grid与texture消费，init producer、capture commit及非均匀三线性另有后继。

## Native provider 首刀与独立CPU门预登记

2026-09-30 root冻结实现方向：从canonical截取`deepGiBoundaryCells`之前的record/level类型、helpers和八角采样函数；仅删除group3 storage声明，将sampleLevel首参由index改显式level，将记录计数/加载改Native provider调用。每个转换接缝要求唯一精确匹配；signature缺失、重复、绑定漂移或未知残留读取立即拒绝。canonical原文件、Web公开storage入口与Native nearest/header/cascade保持。

独立叶`src/probe_gi_native_adapter_tests.rs`只做本刀新增装配合同，不重复十向量或已有CPU三线性矩阵：

- 实际provider无group3/storage-array残留，canonical可见性、法线权重完整函数与八角循环公式保持原字节；显式level和绝对record index由Native提供。
- canonical的截取标记、两绑定、sampleLevel签名、level加载、recordCount和record加载分别缺失/重复/变更时须panic拒绝；异常source不能生成可用shader。
- Naga解析并验证真实provider加Native合法group0行布局；同模块只有一份类型/函数，删除provider或错误record返回类型必须失败。
- Native合法网格仍以`origin+gridSize*spacing`为域上界、record index为绝对96B记录号；八角算法中的recordCount下溢保护、.001权重门、relocation、可见性和原world半球权重必须保留。

证据source身份：正式普通/RT factory共用`native_mesh_shader_source()->String`；`j3_hdr_frame::shader_source`和既有lighting_math组合解析必须调用同一个builder，不能继续手工concat旧片段。实际GPU尚由root另行执行，不以本CPU门替代正式帧。

## root生产接线与实际结果

Native正式八角采样已消费canonical源。适配器只改变两资源绑定、显式level参数及record provider，不复制数学；转换签名缺失/重复时立即拒绝。原96B记录、绝对base索引、头解码、nearest、层选择/混合及binding11保留。普通与RT管线共用library纯source builder，FrameObservation收据和解析门调用同一函数，避免只登记源哈希而漏掉执行代码。

root CPU 6个adapter门及9个原lighting解析门通过；首次重复signature负例发现adapter没有分别检查单行唯一性，补转换guard后6项通过，失败日志 b5-native-adapter-cpu.log 保留，成功为 b5-native-adapter-cpu-after.log。原10个实际storage向量各两draw通过，最大绝对误差1.1920928955078125e-7，沿原fixture容差，日志 b5-native-vectors-after.log。Native正式单层与细粗层GI实帧两具名测试通过，RTX4060/Vulkan确有ray-query能力，日志 b5-native-production-gi-after.log。同source上的6个RT管线变体验证通过，日志 b5-native-rt-pipeline-after.log。

生产factory迁移同时修正旧BRDF实测叶的手拼源与旧函数名，使其消费真实builder；源门1项与实际GPU对独立f64 BRDF门通过，容差2e-5未变，日志 b5-brdf-source-after.log/b5-brdf-gpu-after.log。未运行无变化的全仓矩阵。Web texture/HDR双端正式uniform共同输入矩阵结果见下节；Native init producer、非均匀texture与完整场景不计为本刀已验。

## RGBA16F转换核查与uniform实际收据

原RTNE中点反解比较失败于axis/uniform-a/pixel6991/R：理想采样.25，Native HDR .06842041015625，Web HDR .19482421875；原失败日志`test-output/interrupted-0930/probe-gi-actual/rtne-only-compare-failure.log`保留。原独立HDR绝对门.001一直通过，此处失败源于新增反解门对附件存储舍入方式的假设。

[WGSL 15.7.6](https://www.w3.org/TR/WGSL/#floating-point-conversion)规定非精确浮点转换可选夹住原数的相邻高/低可表示值；[15.7.2](https://www.w3.org/TR/WGSL/#floating-point-evaluation)未指定统一舍入模式。这是语言求值/转换规则。[WebGPU plain color formats](https://www.w3.org/TR/webgpu/#plain-color-formats)定义RGBA16F格式，未提供本核查所需的RTNE附件存储保证；不将语言cast直接当成render attachment转换合同。[Direct3D 11.3 §3.2.2](https://microsoft.github.io/DirectX-Specs/d3d/archive/D3D11_3_FunctionalSpec.htm#3.2.2)明确高精度float转低精度格式使用RTZ，包含16-bit render target例子；该条仅按其Direct3D范围引用，不推及未记录的Native后端或全部WebGPU后端。

独立脚本`scripts/j2-probe-hdr-storage-conversion.mjs`在requestAdapter前固定8个float32值、inline WGSL/sourceHash及RTNE/RTZ两预期，shader只读取storage值，不做片元算术。同一次fresh设备输出RGBA32F witness、RGBA16F sample1及sample4。实际2.52秒通过：RGBA32F全部逐float32精确一致，两种RGBA16F全部RTZ且落在预定相邻值边界，validation errors0。理想Web R .1949289对应存储.19482421875，直接复现生产HDR差异；不需修改DFG、材质、采样数学或原HDR门。证据`probe-gi-actual/storage-conversion/{pre-gpu-fixture,evidence}.json`。适配器公开vendor=nvidia/architecture=lovelace；CDP记录RTX4060及ANGLE/D3D11，但ANGLE身份不等于WebGPU Dawn后端，Dawn实际后端仍unrecorded。

B5新局部反解区间以观察half的前/后相邻可表示值为端点，保留原gamma16；边界由binary16表示预先导出，涵盖RTNE/RTZ，未按观察误差扩大。旧`j3ShadowVisibilityIntervals`中点规则保持。CPU负控制拒绝更远存储bin、非法非half值、上传/材质/帧身份漂移及无正贡献。

现有Native/Web各两fresh收据CPU复算通过：2040个像素点比较、3060个RGB反解区间；Native最大HDR误差.00003243074653000444，Web .00020940865384616592，均小于原.001；两round和两fresh完整HDR hash稳定。`node scripts/j2-probe-gi-actual.mjs --compare`输出`currentRun=false`，明确是已有实帧的CPU诊断，不宣称本次重跑双端。默认统一fresh命令及两设备合同保留。两个实际采集PNG均1920×1080、SHA256=`3294e2eedcf79c1440b9594dc8d44fab4146d20725d367c740ee9a61be360d7a`，画面有蓝/黄几何与深色页。
