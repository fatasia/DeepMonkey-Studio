# I-C23 分层材质生产消费

复用9c56b1fc的base+≤2层合同、凸混合数学与现扩展材质求值，补按层表面/纹理与生产GPU消费。

## 现状核查

1. packages/apps全源检索与git status：materialLayeredParameters/Evaluate/test、materialLayerBlend WGSL镜像均存在；除index/test没有GPU或Native消费；未跟踪工作仅本路C1与其他J/Native域，没有同名分层生产实现。
2. 已读contracts scene、renderPacketTypes与shader参数合同：旧层只携6扩展参数+coverage/mode，base+2层22-f32，每层复用同一个StandardSurfaceInputs。PbrMaterial有extendedParameters，PreparedMaterialTextures有同字段；scene.layers是场景组织层，不是材质层。独立层色/metallic/roughness/texture是真缺口。
3. deep-engine已有WebGPU、纹理数组表/资源、shaderPackage编译执行与Vitest；Native已有固定wgpu/serde发布合同。不新增库或材质runtime。
4. 消费方：Web pbrShader.extendedShade实际调用deepEvaluateExtendedMaterial，沿主直射替换保留已有IBL/GI/emissive；C8直射多散射已消费。materialBindings固定192B块、array行224B，Native普通材质基础块160B；不得静默扩大这些已有ABI。NativeShaderPackage执行器现已存在，但并非分层核已消费证据。
5. 旧19项测试涵盖零层/零覆盖逐位退化、覆盖与overlay混合、白炉/序列化；shared WGSL checksum在仓。已查reports/test-output与原handoff，没有按层表面差异或纹理的双端实际呈现。已有证据不重复计新完成。
6. 0930权威余项明确：响应核接生产GPU、按层表面色差异/纹理与双端白炉；旧首刀9c56b1fc不重建，I-C23仍待生产整项，依赖C8/J3已冻公共缝。

已有（不重建）：≤2层规范化/序列化/22-f32块、共享凸混合核、CPU白炉、单层扩展材质生产Web消费、纹理数组与shaderPackage执行器。

真实缺口：按层surface与纹理合同、GPU打包/资源owner与实际PBR消费、Native对应发布/消费、双端白炉与无层身份保持。先独立surface叶完成输入校验与CPU参考，生产GPU接线须明确192B/224B基础ABI和shader/package新资源合同，不把仅库GPU探针算作生产材质。

## 接线决策与锁

I-C1已通过源继续冻结供root收割；本阶段只核查/新独立叶。C8 pbrShader与Native归对应owner；材质基础ABI保持现值，新增分层资源候选按既有DeviceSession/PacketBuffers生命周期原子发布。GPU只深色1920×1080两fresh，按层差异与纹理需实际使用的主材质PSO与owner资源证据。

Design Read：同一物体上的底漆/表层色、粗糙度与层覆盖可辨，参数关闭回到已有底材；沿既有工业PBR与base.css，不新增展示平台。

304B层块为uniform（header16B+2×144B行，16B对齐），不占Forward+现8个storage预算。features.layeredMaterials默认false：普通shader/layout/上传路径保持；显式开启后请求19个片段纹理上限，四层槽D2 view/sampler沿TextureResources借用，不重新上传；未纹理层仅按需中性1×1纹理。Layer binding随现MaterialBindingPool引用退役，304B独占参数必须在构组失败/候选失败/发布旧代/清除回收，borrowed纹理不得释放。Native仍需root接包与实帧，Web首刀不能单独整项关闭。

## Web生产首刀结果（整项仍待Native）

10文件88测PASS，engine tsc PASS；实机两fresh dark1920×1080走PbrRenderer/正式材质PSO/packet资源owner，before/after全部engine src与WGSL SHA相同。来源为test-output/i-series-0930/layered-material-production/evidence.json：两轮passed/stable/sourceFresh=true，errors=[]、dispose资源0。

35点以底材、逐层两个单独实际HDR帧独立计算replace与overlay组合，包含颜色sRGB采样、MR线性采样、UV0/1独立变换和纹理alpha覆盖；最大误差0.0002932543693296985，阈值0.002。纹理开关实际delta0.2967529296875；作者coverage0和纹理alpha0均净差0。非法coverage和预取消都保持旧资源。E=0.5全白Lambert炉内实际最大误差0.000244140625、双层对白底材净差0，每轮显像716800像素/8色量化箱；两轮two-layers图已核看。

失败历史保留三个immutable目录：failed-grading（fixture错把普通contrast中性值写0）、failed-receipt与failed-direct-receipt（合法directDisplay只执行opaque，不产HDR/present）。数值fixture采用C15既有中性authorColorEffects选择HDR输出；普通零特效fast display本身不是失败产品路径，首刀未扩成另一轮fast-display矩阵。

Native真实差异：contract/types PbrMaterial deny_unknown_fields，既无extendedParameters也无layered；builtin基础160B/五纹理，没有本304B块。shader_package可自定义执行，但尚无相同层材质发布/生产消费。Native后继由root协作，不能把Web结果算双端或整项已完成。

保存重开核查：serializeBrowserRenderPacket已有snapshotJson会保留新字段；materializeRuntimeRenderPacket现共用Native闭字段白名单会拒绝layered/extended，这是待最小修复的Browser hydration缺口。Native发布validateRuntimeRenderPacket仍应严格拒绝未支持字段，不能静默丢层。

视觉范围：SDK生产材质色板，四块图案/颜色与覆盖差异清晰，深色1080两轮一致；没有新增编辑器UI，字体/钻取/工业信息维度不适用。材质环境/纹理结果为生产渲染证明，界面与Native全项评分待后继。

## Web首刀精确收割（24文件，生产冻结）

- docs/specs/i-c23-production-layered-material-20260930.md
- packages/deep-engine/src/renderPacket.ts
- packages/deep-engine/src/renderPacketGeometryFeatures.ts
- packages/deep-engine/src/renderPacketMaterials.ts
- packages/deep-engine/src/renderPacketTypes.ts
- packages/deep-engine/src/shader/index.ts
- packages/deep-engine/src/shader/materialLayeredSurface.ts
- packages/deep-engine/src/shader/materialLayeredSurface.test.ts
- packages/deep-engine/src/webgpu/deformationDrawBindings.ts
- packages/deep-engine/src/webgpu/deviceSession.ts
- packages/deep-engine/src/webgpu/deviceSession.test.ts
- packages/deep-engine/src/webgpu/deviceSession.recovery.test.ts
- packages/deep-engine/src/webgpu/materialBindings.ts
- packages/deep-engine/src/webgpu/pbrPipelineSet.ts
- packages/deep-engine/src/webgpu/pbrRenderer.ts
- packages/deep-engine/src/webgpu/pbrRendererFeatures.ts
- packages/deep-engine/src/webgpu/pbrRendererFeatures.test.ts
- packages/deep-engine/src/webgpu/pipelines.ts
- packages/deep-engine/src/webgpu/textureArrayResources.ts
- packages/deep-engine/src/webgpu/pbrLayeredMaterial.test.ts
- packages/deep-engine/src/webgpu/pbrLayeredMaterialBindings.ts
- packages/deep-engine/src/webgpu/pbrLayeredMaterialShader.ts
- packages/deep-engine/lab/iC23LayeredMaterialProduction.ts
- scripts/i-c23-production-layered-material.mjs

## Browser 保存重开补刀现状核查

1. 全源关键词和未跟踪检查：只有本 runtimePackage/renderPacket.material 闭字段入口缺少新字段，serializeBrowserRenderPacket 已保留；无另一份 hydration 实现。
2. 合同复用 MaterialParameterOverrides、LayeredSurfaceOverrides 与 normalizeLayeredSurfaceParameters；不新增材质合同或 ABI。
3. 现有 Vitest、snapshotJson 与 typed-array materialize 无需新依赖。
4. Browser runtime materialize/Three author packet 消费此入口；Native validate 调用同 parser，因此仅 Browser profile 独立允许两个字段。
5. 既有 renderPacketMaterialize/Deformation/runtimePackage 测试保留；新增 304B 逐字节、UV/纹理身份、输入快照和未知字段/NaN/Native 拒绝回归；生产 GPU 只追加恢复后单帧，不重复已通过矩阵。
6. 本规格已记录保存重开真实拒绝；4debbb8d Web 首刀完成，Native 未消费的能力差异仍保持。

已有（不重建）：Browser 序列化 JSON 快照、类型数组还原、层参数规范化、纹理和 UV 生产上传。真实缺口：Browser parser 对扩展/分层字段的独立校验及快照恢复。锁 runtimePackage/renderPacket.ts、新独立 Browser 材质叶与测试；C23 lab/runner 仅增加一轮 rehydration 模式，原 immutable 生产证据保留。

Browser 补刀结果：4文件74测 PASS（新叶11测）；engine/lab tsc PASS。test-output/i-series-0930/layered-material-rehydrated/evidence.json 为唯一1fresh realm 的恢复后增量门，35点作者帧与 serialize→JSON→materialize→实际 PbrRenderer 上传帧 HDR 差0；716800可见像素/8色箱，sourceFresh/stable=true、errors=[]、dispose资源0。两张作者/恢复图已目视，图案和颜色相同。原两fresh production矩阵证据保留；本次没有将1轮标作2轮。

Browser补刀收割（6文件，source冻结）：
- packages/deep-engine/src/runtimePackage/renderPacket.ts
- packages/deep-engine/src/runtimePackage/renderPacketBrowserMaterial.ts
- packages/deep-engine/src/runtimePackage/renderPacketBrowserMaterial.test.ts
- packages/deep-engine/lab/iC23LayeredMaterialProduction.ts
- scripts/i-c23-production-layered-material.mjs
- docs/specs/i-c23-production-layered-material-20260930.md

Native闭字段仍严格拒绝layered/extendedParameters；Native消费与双端白炉后继未完成，I-C23整项保持进行中。
