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

固定原85点、两相机、每profile两draw；非金属0、roughness .8、法线偏移原 .2。合法27探针 origin[-16,-16,-16]/spacing16/gridSize[3,3,3]，validity1、meanDistance100000、variance1、relocation0。三个uniform输入为zero/[.25,.5,1]/[.5,1,2]，采样点位于双方域内且有正半球角权重。

正式prefiltered IBL黑diffuse/specular与恒定DFG[.75,.0625]，IBL启用、无直射/雾/自发光。Native mode0为控制，mode2消费作者grid；Web真实setProbeClipmap/texture绑定zero为控制。CPU期望分别为 Native base*irradiance/PI 与 Web base*irradiance*(1-specularFraction)，其中specularFraction=(.04*.75+.0625)*(1+.04*(1/(.75+.0625)-1))。原85点全比较、alpha1、正增量及两draw/fresh完整hash；绝对half门预注册 .001。两宿主完整HDR公式差异保留，采样值按各自正式混合反解后才比较；不是同HDR对拍，也不覆盖capture producer/staging或非均匀网格。

实际GPU结果待主线程串行执行；新purefactory身份使用 native_mesh_shader_source，不再用静态concat遗漏provider装配。

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

生产factory迁移同时修正旧BRDF实测叶的手拼源与旧函数名，使其消费真实builder；源门1项与实际GPU对独立f64 BRDF门通过，容差2e-5未变，日志 b5-brdf-source-after.log/b5-brdf-gpu-after.log。未运行无变化的全仓矩阵。Web texture/HDR双端正式共同输入矩阵仍由J3叶接着补，Native init producer、非均匀texture与完整场景不计为本刀已验。