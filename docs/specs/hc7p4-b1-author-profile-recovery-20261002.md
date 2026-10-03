# H-C7-P4 B1 作者 profile 恢复续作（2026-10-02）

## 现状核查（六步）

1. 全仓 grep apps/*/src、packages/*/src 的 clearcoat/targetAbi/shaderAbi/shaderAbis/DeepSlPackage/material.set，含未跟踪与git状态；sceneCustomShader/runtimePackage目标叶当前无并行改动。root账本只读，开工指纹 `9f5fb9a542af5b9b25a4a93e51f930446071845a0f457eafc4d74ba884c9cfd1`（上一批后主线程更新，并非本线写入）。
2. 类型已读：SceneMaterialState.customShader既有 `{source:string}`；SceneMaterialCommandPatch目前无customShader；DeepShaderPackageV2是 **包schema v2**，不是shader ABI固定v2；DeepSlPackageAdapterResult已含typed shaderAbi与clearcoat report。ABI v2实例144B，v3实例160B（objectId @location14/offset144），v3沿v2 forward/CSM而增加aux depth/picking。
3. 依赖已查：既有Three/Vitest/TypeScript与workspace exports，零新依赖；CPU只用exec vitest，禁cargo/GPU/帧时。
4. 消费方：CustomShaderEditor沿inspectSceneCustomShader绑定原source；compileSceneRuntimePackage→compileSceneCustomShaders→runtime build，runtime validation/deepSlMaterial固定v2；ShaderPackageExecutor及descriptor已能解析v3（既有CPU专测），但stock prepareRenderPacket仍36float/144B，Native player_shader_plan/runtime material_bindings仅v2。全仓不存在名为shaderAbis的既有字段，拟定为本地宿主能力选项，不写wire。
5. 测试/证据：sceneCustomShader2、deepSlMaterial6、runtimePackageBindings15、packageClearcoat4、shaderAbiV3/ShaderPackageAuxiliary已存在；旧31/31 B1守卫与旧browser拒clearcoat证保留。I23活动层数学/GPU已验不重建。本批新增反例仅作者profile/包消费/stride，不用CPU包准入冒充draw。
6. 规格已读P4基准、ready-evidence、P4旧browser、I-C23 clearcoat production及recover/handoffs检索。B1原门仍含作者material.set保存重载与fail-closed，不能换题只看内核。

**已有（不重建）**：clearcoat parser/typed defaults/v3适配WGSL、v1/v2冻结ABI、Shader Package v2序列化/哈希/执行器、作者现有源码面板、保存source合同、SDK studio.material权限。

**真实缺口**：作者preview错误固定targetAbi=v2（合法clearcoat必拒）；runtime通用材质默认只允许v2是与Native一致的**正确默认**，不能盲删；v3实际实例stride需独立能力化CPU打包，不能把144B喂160Bdescriptor；material.set作者source字段由主线程集成。

## 最小方案与类型范围（写入后才改实现）

- 保旧source仍编译v2，cache与原hash不漂移；仅当既有adapter结构化报告精确 `unsupported-capability/$.source.clearcoatFactor` 时选v3（解析器决定，不regex猜字段），预览能诊断合法扩展，越界/未知源仍拒。
- inspectSceneCustomShader允许本地host选项 `shaderAbis?: readonly (v2|v3)[]`，preview缺省支持v2/v3；compileSceneCustomShaders的生产缺省v2，只有显式v3宿主声明才可输出v3包。缺能力人话拒，不静默降级；无新增UI/按钮/步骤。
- runtime材质构造本地options同能力白名单缺省v2，v3显式准入；全平台validateRuntimeMaterialBindings/Native v2默认不改。新增实际instance stream适配纯叶（复用PreparedBatch真实36float前缀，v3扩40float并明确objectID映射），CPU验证160B与@location14/offset144一致，v2返回原流不复制不改字节。
- profile能力不是wire/schema/公共contracts变更；DeepShaderPackageV2、shaderAbi常量、I23/PBR shader均原样；所有新增函数预算≤80行，新增纯叶≤120行，正式测试复用当前文件。

认领实际修改叶：apps/web/src/delivery/sceneCustomShader.ts/.test.ts；packages/deep-engine/src/runtimePackage/deepSlMaterial.ts/.test.ts；runtimePackage/index.ts仅新纯helper导出；若需要新增shaderInstanceProfile.ts（≤120行）另回报。runtimePackage/materialBindings.ts与runtimePackageBindings.test.ts当前只读，Native默认守卫保留不放宽。主线程SDK protocol/validation、ViewerSceneCommandPort/ScenePrimitiveOwnerPort、pbrLayeredMaterialShader/packetBufferStaging/selfcheck/intensity测试本线零触碰。

## 主线程集成合同（本线不擅改）

只在SceneMaterialCommandPatch Pick既有customShader `{source:string}`，非空、UTF8≤32KiB、nested unknown/getter/proto拒，studio.material/object权限沿原合同；ViewerSceneCommandPort消费前编译校验，支持profile以真实宿主能力决策，失败不触材质。没有新clearcoat scalar/公共合同。

可复跑source = 既有Standard源插 `clearcoatFactor 0.85; clearcoatRoughness 0.08;`；负控factor1.5/unknown field拒；无clearcoat和factor0须保持默认中性，显式旧v2 ABI拒扩展依然有效，不改adapter原守卫。

## 验收矩阵与边界

CPU先红→绿：合法clearcoat作者入口被固定v2拒；显式v3 runtime构造被旧default守卫拒；把144B流误喂v3必须拒/扩正确160B。邻居v2输出逐字节/zero源码模块恒等、双面/透明/材质纹理/非法payload/未知ABI都保门。

七轴：主路径source→inspection→profile包→defaults/instance stream→JSON恢复；边界zero/empty/max source/unknown ABI；失败非法source/不支持能力/错误stride/objectID；并发与重复deterministic/hash/detached clone；恢复JSONsource/profile一致；权限主线程正式SDK守卫；呈现本批CPU未执行（无GPU窗口），不得声称真实像素或新浏览器闭环。

## 子批实测与实际边界（profile恢复，不等于B1产品已关）

- 原红两反例已落 `test-output/hc7p4-b1-author-profile-recovery-20261002/web-red.json/.log` 与 `runtime-red.json/.log`：合法coat因固定v2返回false；显式v3消费者也被旧fixed-v2拒。两条修后原路径过，保红证不覆写。
- 作者preview选profile：no-coat包与原v2完整对象逐值相等；clearcoat扩展只按原typed adapter拒绝码/path升v3，不靠regex/错误重试；因子越界、unknown声明、显式v2 consumer继续fail-closed。生产compile缺省v2，显式v3只本地options；JSON重开源码/包哈希一致。
- runtime材质defaults：v2缺省准入保持，显式v3材料为已有compile-time coat，不加extendedParameters再算一次；zero材料JSON与旧v2完全相等。全平台runtimePackage/materialBindings与Native守卫未改。
- 新纯叶 `runtimePackage/shaderInstanceProfile.ts` 45行：复用真实PreparedBatch的144B前缀，v2保同data原字节不分配；显式v3扩160B，36float前缀逐位保持，@location14/offset144非零uint32→RGBA8-f32正确；缺ID、0ID、错误stride、未知ABI拒。index薄导出，不污染stock packet布局。
- 原lab draw/support薄接该helper，reported instanceStride按真实144/160；legacy deepSlPbrProbe额外一行144守卫（不宽化原门）。第一次lab类型两错（ArrayBufferLike→owned ArrayBuffer、旧literal144传播）精确修在本线并保失败log；三配置最终typecheck0、Web最终typecheck0。
- **GPU只在协调者确认F5释放后执行**：原 `scripts/r12FrameCaptureGpuTest.mjs --clearcoat-only` + B1_GPU_ROUND=1|2，原server/Chrome/CSM helper，不新宿主。两fresh三包均实际v3 forward1+shadow1/stride160/rgba16float4xMSAA resolve读回；invalid factor1.5编译前拒；implicit-zero与explicit-zero raw16均 `[14608,11639,11318,15360]`，coat raw16均 `[16588,16178,16049,15360]`、maxRGB差 **1.765625**，零位恒等、coat正变化、errors0。全部631实际bundle输入before/afterSHA一致，两轮bundle SHA同 `bd4ce42b67fc132795c9925ee36f404dc33ef45481fcf989068cf196fceb7d4b`。`gpu-round{1,2}/evidence.json`可复跑。
- 本机既有 `C:/Users/rain/.cargo/bin/naga.exe` 正式v3 Standard+Unlit完整模块检验通过，不运行cargo；CPU fake descriptors绝不计GPU。原I23核不重复构建/矩阵。

**B1仍partial**：源码可preview/保存是作者文档行为，Three/StudioDeepBridge即时并不消费shader package；Native/stock144B wire保v2，production Web真实包材质动态绑定还未接。本批独立labGPU不作为Studio产品就绪。公共contracts/主线SDK/ViewerCommandPort/ScenePrimitiveOwnerPort/driver/PBR shader/staging/selfcheck皆不碰，无新增UI或步骤。下一刀按协调指令只读审查真实consumer薄接线。

最终本子批CPU去重：Web4文件59/59、Deep11文件69/69（含既有完整v3 Standard+Unlit Naga用例），合计 **15文件128/128**，零失败/零pending；证据web-final/deep-final。Deep主/lab/examples与Web完整类型最终均exit0。阶段draw-cpu有1个可选Naga skip不计通过；后naga-cpu/deep-final显式开启已有bin，skip=0。红2例/type首失败均保留，不以最后绿抹过程。

## 下一刀：产品实时consumer六步设计审查（只读，无实现认领）

### 已核查的原路径与公开ports

- 主路径 `useAppRuntimeEffects.ts:516–551`：captureSceneSnapshot→compileSceneRenderPacket→cache `{key,packet,clusters}`→StudioDeepWebGpuBridge.authorRenderPacket，仅绘制数据没有shader package。`SceneMaterialState.customShader`是作者source，不应塞公共contracts第二形状。
- `StudioDeepWebGpuBridge.ts:66–86,286–324,629–632` 已有 `authorRenderPacket(signal)`、candidate generation/AbortController/首帧validate/publishDeep/releaseDeep；独立包开启后不再重编译作者内容，实时source变化必须有明确revision-triggered sidecar同步，而不是新RAF loop/控件。
- `DeepWebGpuBackend.ts:25–51` 的public runtime ports：setPacketValidated/updateInstances/render/validateFrame/stageEnvironment/stageShadowMapSize/dispose；目前没有shader-material staging port，需新增optional capability port，缺省strict unsupported不能假实现。
- `PbrRenderer.ts:279/295/629` 在既有PacketBuffers owner上传与draw；`ShaderPackageExecutor.prepare(package,passIds,signal)`只PSO+layout，不负责任何frame/material/instanceGPUbuffer。它已有devicequeue串行error scope、缓存、abort/loss/dispose；可复用，无新renderer。
- `ShaderHotReloadRuntime`已有request/compileNow/publishAtFrameBoundary/current/candidate/dispose/generation/LKG；product引用只有导出无消费，prepare内部targetAbi默认v1（与author新增v2/v3不一致），不能直接new就称接通。可复用其事务纪律或让其explicit profile可选，但它不是材质/geometry owner。
- PacketBuffers已有setValidated/stageResidentProjectionValidated/publishResidentProjection/commitFrame/cancelPendingPacketStage、DeviceSession admission+retirement，新增材质candidate须与packet同epoch同revision原子提交，不能两块独立ack。

### 机制约束与最小接线（待主线程统筹）

| 阻点 | 已有事实 | 最小动作/边界 |
|---|---|---|
| 材质身份 | renderPacketBatches key未含materialId，plain不同source共几何可合批；PreparedBatch只instanceIds | 本地shader sidecar以instanceId→material package分组；stock无source分组原key保持；自定义对象不得混进stock批 |
| ABI流 | stock 144B，v3 160B/objectId | 新profile helper已actual CPU/GPU验；自定义owner旁流160B，stock/residency/culling原流144B不擅改全族 |
| 帧绑定 | stock group0 bindings0..11，binding7=diffuseBuffer；package v2/v3 binding7=CSM336 | 同device新package frame bindgroup复用已有frame/env/shadow**资源**但按包layout重绑；不能复用stock主bindgroup |
| 附件 | stock opaque可MRT normals/MR/motion；package v3仅rgba16float4x+depth24 | 先受限static OPAQUE/MASK且明确禁止SSR/MRT需求不兼容的profile，或专用同frame单HDR pass复用目标；缺能力拒，不悄丢normals/motion/效果 |
| 纹理 | package材质11 bindings/normal tangent slot2 vs stockprevious+tangent3，stockMaterialPool192B扩展 | 首片plain coat复用数字defaults；纹理扩展后必须原dummy/UV/normal语义保门，未知source拒；不复制新纹理库 |
| 更新 | bridge独立packet不sync | capture snapshot revision+hash变化时编译once/latest abort，sidecar与packet stage同generation；不让camera每frame重编译 |
| 生命周期 | executor PSO无destroy,buffer有DeviceSession ownership | candidate fail释放仅新buffer，active保持；frameBoundarypublish后旧buffer等待queue/retirement；dispose/loss全部清零、不得候选晚到复活 |

**建议类型只在引擎/宿主本地**：`AuthorShaderSceneCandidate={packet, shaderPackages, materialBindings, authorRevision}`；optional `stageAuthorShaderScene(candidate,signal):Promise<'staged'|'superseded'>` + `cancelAuthorShaderStage()`；public可读supported shaderAbis；wire RuntimePackage默认nativev2原样。P3作者事务receipt committed只能表示源码文档改动；需绘制receipt profile/source hash/实际pass/实例数才能声称B1即时像素。

**实际候选修改叶（尚未认领/未写）**：useAppRuntimeEffects.ts、StudioDeepWebGpuBridge.ts及既有候选/动画tests；DeepWebGpuBackend.ts/publicRuntime及其creation/tests；PbrRenderer.ts最小optional owner接入与frame-boundary/draw挂点（它已>800行不应堆实现）；packetDraw.ts或新≤300行ShaderMaterialDrawOwner叶；local sidecar types小叶；hotReloadTypes/hotReload或单独compiler适配薄叶；packetBufferTypes/分组逻辑需主线审避免与staging锁重叠。公共contracts/SDK清漆scalar不扩，不新编辑页面。

**验证最低面**：同场两个对象仅一个coat（材质分组负控）；first-frame真实校验；coat0与no-source raw16恒等；源码切A→B→取消A迟到不夺权；failed compile/upload/frame active逐值保持；撤销/保存重开source与像素一致；两个device epoch/loss/dispose资源0；只在被限制profile下rendererSupported true。独立lab过不能替代上述产品consumer gate。

本设计只是scope内后继方案，不称完成产品、不开GPU新矩阵、不改主线程叶。root仍只读，无commit。

### 协调者收窄结论：不实施sidecar，声明式材质优先（当前只读）

sidecar上节是已经核查的通用包consumer代价，**不作为首选、未写renderer接口**。B1 DeepSL是受限声明式Standard/Unlit/clearcoat，不承诺任意WGSL/addon；优先lower到现有材质核。

实际再核纠正：`threeBridge/materials.ts:128–141`仍拒所有非中性Physical clearcoat，并非已在映射；`renderPacketMaterials.ts:47–48`无贴图base extended会拒。现I23 `layered`可plain、coverage1/replace的同base surface单层clearcoat走已验stock304B+144B，Native支持活动层清漆而仍拒基材扩展。这条路无需新PSO/renderer/ABI/wire。

**5–8叶最小候选（本次仅方案，尚未写）**：

1. 复用sceneCustomShader或新≤180行 `sceneDeclarativeMaterial.ts` 纯lowering：用已有parser/typed report.materialDefaults+clearcoat产生material value；先plain Standard与Unlit，texture on/自定义任意函数/非法结构严格拒，typed source/hash只缓存cold edit。
2. `viewerEngineObjectState.ts`/一个薄viewer helper：prevalidate全slot后lower到既有Three材质，非零coat按`prepareMaterialIor`同owner模式promote Physical（保材质源快照/纹理/屏幕owner）、因子零或解绑恢复原类/值，snapshot仍存原source而非第二套合同；Unlit只在可无损类转换时接，否则先拒。
3. `materialIor.ts`只抽既有clone/promote helper或扩条件，不另立promotion族；publiccontracts不改。
4. `threeBridge/materials.ts`收窄支持清单：纯scalar clearcoat factor/roughness可验证并lower为已验单layer，其余physical anisotropy/transmission/maps等仍拒。零coat不加layer保持旧投影；同base surface coverage1是“clearcoat同基材响应”而非叠两个材质。
5. `sceneMaterialOverrides.ts`/`sceneSnapshotRenderPacket.ts`及其纯helper在独立作者packet compile读取persisted customSource，相同lowering产stock `layered`；普通source/neutral packet逐位不变，避免Three path有而独立packet永远漏source。
6. `sceneCustomShader.ts`的runtime发布：对已完成declarative lowering不再强绑compile-time shader package；Native wire旧包原v2守卫保持，支持结果沿stock layered serialized字段，不强升v3。通用package原路径可独立保留，不互相伪装。
7. `useAppRuntimeEffects.ts`/StudioDeepBridge须评估独立packet静态快照刷新：现standalonepacket不sync，新source事务提交后需要原candidate再发布或已有revision→compile更新入口，不新增用户步骤。优先只在source/作者数据revision变化触发已有switch replacement原子链，camera帧不重编译；该叶主线大文件先协调。
8. 正式材质/投影/保存测试：含旧neutralPhysical反例收窄、decl-source两对象隔离、解绑/zero字节、非法slot整批零变、保存重开源+Three字段+Deep304B同值；沿原UI无需新面板。

**取舍**：无需通用runtimeShaderMaterial sidecar/新渲染器/新layout/帧MRT接口；只薄编译材质与现有I23消费。仍要实际确认Three coat与Deep层clearcoat响应语义差（需要同source几何照明正负控，不凭“有参数”签像素）；若Three路径默认depth/texture/unsupported组合不支持则fail-closed而不是默改源。

此候选名册非实现认领，留协调者统筹下一刀；本profile子批先交红→绿/实际独立draw证据与B1 partial。

## 自查与交付边界

- 工程10维针对本profile子片各9/10：六步盘点/方案先行、复用原parser/executor/helper、old-red/old-v2-byte/zero/explicit-capability/坏stride反例、128唯一正式CPU+三配置类型+631源双fresh稳定、无公共wire/用户操作扩散。没有测帧时，不把CPU适配复杂度O(N)说成实机性能收益。
- 测试8维针对子片各9/10：原红两例真失败、同族CSM/Naga/v2/源budget/profile等覆盖、实际forward/shadow/readback而非prepare-only、invalid-before-GPU/zero-half-bits正负控、失败log保留、产品consumer未接如实partial。独立16×16数值probe不作页面视觉95%评分，不需要新UI；无Studio浏览器即时材质像素验收，故B1总体不能签done。
- 本线文件体量：新shaderInstanceProfile45行；原sceneCustomShader保持小叶，lab draw约240行；无renderer大文件新增。本地assets/用户文件未修改、无commit/push/reset/clean/stash、禁止cargo/帧时；source/data/tmp仅既有runner隔离路径。
- 最终证据 `test-output/hc7p4-b1-author-profile-recovery-20261002/report.json`、GPU `gpu-round{1,2}/evidence.json`，以其退出码/实际源哈希/执行数据为准；规格可选方案不是已上线实现。

### 收窄方案锁（协调者已采纳方向，具体leaf lock待确认，CPU未开写）

只接受编译验证的受限DeepSL author source→metadata/source哈希+物理材质；桥必须检验受控来源，不盲放所有third-party nonneutralPhysical。coat为已有I23单层 coverage1/replace，surface显式baseColor/metallic/roughness；zero/no-source不挂layer保持旧字节。WebGL真实MeshPhysicalMaterial，不用onBeforeCompile hooks改任意GLSL。

拟定生产叶最多8：①shared纯declarative lowering（parser/report复用）；②Viewer controlled-material helper；③viewerEngineObjectState薄调用；④materialIor原promotion抽共享；⑤threeBridge/materials受控来源特例（外部unsupported原样）；⑥sceneMaterialOverrides与snapshot静态编译共用lowering（两薄调用，不自造核）；⑦原authorpacket revision候选同步交主线大叶；⑧sceneCustomShader识别已lower避免重复绑定包。新helper≤180行，测试沿materialSlotsRuntime/ThreeProjection/sceneSnapshot正式入口，不加UI。

active-layer启用按既有capability/device limits自动协商；19 textures与F5新moments组合若超默认上限，沿现已披露降级/拒绝策略并记录组合门，**不主动抬limits、不静默让用户掉功能**。F5/PBR shader/staging/PSO/renderer接口皆不扩；具体锁由协调者确认后才CPU实现，不问用户替内部调度决定。

## 受控lowering实施方案（锁已确认后续刀，CPU先）

续六步：重扫customShader/primitive owner/slot clone/Physical拒绝/静态packet调用，读materialIor/primitiveMaterial、SceneMaterialState与DeepSlSurfaceModel、packageMaterialDefaults/layered/native guard、已装依赖零新增、消费family正式tests及旧拒绝、现规格与只读root。真实现状不改：Three桥外部Physical非中性拒；stock plain base扩展拒；I23 plain活动layer已有借用中性texture+304B，因子zero不需要layer。

- 新引擎纯 `shaderAuthoring/declarativeMaterial.ts`（≤300行）输出编译detached/frozen defaults、canonical **原source** SHA、只受限plain Standard/Unlit声明，parser/adapter已有校验；textures on/非单位/未知声明fail-closed。声明式结果不是任意WGSL沙箱。
- 在同纯叶的WeakMap按**材质对象身份**记“由宿主编译应用”的source/defaults hash；桥不能信任userData可伪造tag，只消费WeakMap记录并逐关键实际材质值核对。clone/JSON自动失去记录，只有Viewer应用canonical source重编译/注册可恢复；外部无记录nonneutralPhysical原拒。导出注册是可信main-thread端口，不宣可防任意执行代码的攻击/沙箱。
- Viewer纯helper保存编辑前材质baseline clone/必要属性在WeakMap，第一次应用source按已有promotion复制规则，保slot/sourceLinear/textures/onPromote回调更新原纹理/屏幕owner，不共享cache侵染。修改前全slot source/profile/IOR验证；非法任何slot不detach、不dispose、不改对象，先算后换装。
- source默认Standard/coat0不升Physical（保持旧shader路径），active coat才MeshPhysicalMaterial；解绑显式customShader undefined恢复baseline class/values/owned metadata后再应用当前普通patch；source还原/zero保canonical source，不存derived defaults为公共scene字段。所有材质替换old dispose恰一次，texture只借不另销毁。
- Deep packet同lowering把active coat变同baseColor/metallic/roughness surface、coverage1/replace单layer，noSource返回原material对象、coat0不挂layer；原alpha/slot/材质资源拒绝照常，跨renderer包profile不改。Native走已有layer字段、默认全平台v2包guard不删。
- 本线实现纯helper、Viewerhelper/objectState/materialIor、threeBridge/materials、静态materialOverrides/snapshot、sceneCustomShader；主线程负责App/bridge revision通知/能力自动协商，不碰其renderer/PSO/staging。19textures/F5moments组合门不抬默认limits，能力未满足显式降级/拒绝。

边界测试：plain相同geometry二对象只一对象coat；dirty clone/伪tag拒；source默认0/移除恢复class+source值、texture对象未dispose；invalid第二slot整批零mutation；slot source优先、JSONcanonical重载参数恒等；static packet与物理投影lowered304B一致，coat0旧packet逐位；任意扩展/source非法不quiet-drop。本刀无GPU，待协调原产品consumer闭环，不凭参数签像素。
