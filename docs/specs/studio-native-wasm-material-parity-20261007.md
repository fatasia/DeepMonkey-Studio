# Native / WASM 源材质一致性

目标：同一SMT源材质保留高光强度/颜色贴图和玻璃透射，Native与WASM使用共用Rust生产代码。

## 现状核查

1. 全仓源码与未跟踪项已查 `specular`、`transmission`、`MaterialTextures`、透明pass。WebGPU已接七槽；Rust仍为五槽，stock扩展拒绝非零transmission。
2. 契约：`contract/types.rs` 的PbrMaterial缺少四个specular字段，TextureSemantic缺少两种语义；`mesh_abi.rs`已有240B高级带，其中45偏移透射因子已存。
3. 依赖：Native已有wgpu30、serde、bytemuck；WASM直接依赖并镜像Native模块。沿用现有依赖，无新渲染器。
4. 消费方：`pbr_texture`准备行、`gpu_textures`上传绑定、`native_mesh_wgsl`组装及`renderer/frame`生产pass已有。透明pass消费MSAA场景色，opaque HDR已经resolve，但没有独立opaque采样源。
5. 测试与证据：stock扩展测试当前验证拒绝透射，七槽GPU探针仅证明TS宿主；Root实际WASM出现mat0/mat2的advanced-materials拒绝。旧NativeEXE不能证明本次能力。
6. 规格：按10月7日handoff、active-task-recovery-ledger及最新用户三引擎要求校准；旧保守子集合同需要扩展，写明拒绝不是修复完成。旧能力扩展计划路径当前不存在，以上述现存规格为准。

已有（不重建）：UV0/UV1和仿射变换、sRGB/线性上传、材质缓存、排序透明、4xMSAA、opaque HDR、IOR和共享BRDF。

真实缺口：specular字段→语义→纹理索引→uniform→绑定→F0/F90；透射源色复制/绑定与屏幕采样；TS Native包写出守卫及WASM前置材质准入必须在Rust消费齐备后同步开放。

## 实施与验收

先补共用CPU合同、七槽纹理及320B材质行，再补共享Rust shader与生产绑定。透射保留源alpha，复制当前opaque HDR到独立纹理，避免对正在写入的颜色附件采样。Native/WASM重用同一着色核与功能测试；最后实际SMT及黑白高光遮罩/玻璃内部可见性GPU回归。

## 当前证据（22:11）

运行包编译器补核：源码/未跟踪项、CompileSceneRenderOptions合同、既有依赖、Studio→compileSceneRuntimePackage→compileSceneRenderPacket→buildDeepRuntimePackage消费链、编译器/Runtime Package测试及本规格已复查。已有精确Native writer支持检查不重建；真实缺口是runtime编译器漏传advancedMaterials，以及旧assertNativePackageMaterials一律拒绝所有扩展。移除重复笼统守卫，交给实际package builder的字段/数值/能力检查；非零anisotropy/iridescence/volume及活动层unsupported继续按精确路径拒绝。

同族Native发布客户端和API worker入口也已启用advancedMaterials与112MiB贴图预算。源materialLosses阻止发行降级包；真实不支持的参数仍定位到具体合同路径。最终编译器/实际PNG/Native冻结包/客户端5文件67项、API实际compiler worker11项和Web typecheck通过。API compiler leaf已刷新，SHA `b12ea3b0cbd59f93cafaa49c61e44b921335b1d491e64f9d4b9b26737fd43508`。能力登记Rust/TS/共享fixture按当前320B与specular/stock transmission更新，原advanced reduced-tier保留，三方对拍22项通过。

- Rust CPU：七槽/320B、源RGBA、独立UV0/UV1、alpha/MASK和透射因子 11 项通过；contract旧240B零带测试已收窄到原前缀，新specular中性值为1。
- Native生产host `cargo check --bin deep-engine-native`通过。Raster/RT组装WGSL经Naga解析及验证通过。
- 真GPU：RTX4060/DX12，设备显式使用默认16采样纹理上限；生产mesh/culling/opaque/transparent管线、320B uniform和七槽绑定通过。高光factor0消失、颜色通道、sRGB贴图、线性alpha强度、UV1翻转生效。源OPAQUE且alpha1的透射窗采到实际当前opaque内部：红背景 `[2.111328,.113464,.113464]`、蓝背景 `[.113464,.113464,2.111328]`，stock为`.079163`。一个GPU测试涵盖以上项目，8.31秒，无验证错误。
- 证据：`test-output/native-physical-material-gpu2.stdout.log`、`native-physical-material-gpu2.stderr.log`。第一次fixture误写tuning行，主光未生效，阈值失败；第二次改为Frame lightDirection行11，未放宽生产校验。
- TS Native写出准入已同步四字段/两语义/stock transmission；public publish→materialize三文件59项通过，层栈透射守卫保留。
- WASM共享Rust生产模块target check通过；正式wasm-release/Oz最终构建及安装public目录通过：wasm 5,694,771B，JS 116,272B。wasm SHA `9aedc9d0fa69ed0a1be04d8d7061d198219416e0f5f08e7fa99d183ff32564b6`，JS SHA `548b886ed8fec5e707ce88fbbfbc2e4e711192b613714eb44213342e9d54e04e`。最终903项源码 fingerprint `52d091031a6b1eedb1d408b0614f829b41c163836318345a586cf01adbb7186f` 与manifest、Native构建前后身份均一致。真实浏览器SMT与安装客户端仍待新Web包验收。
- Windows x64 Native正式release/+crt-static/jobs1构建通过：22,163,456B，SHA `73e276143251be96e81c4472a4381fc1ad6312a006316122d9fe5748e45dfbaf`；PE AMD64/PE32+，导入表无VC redistributable DLL。新EXE的stock physical contract/pbr预检通过，并实际消费TS生成的134,219,959B运行包：六张2048RGBA共96MiB，资源/包canonical hash `7674e4506b99944351a499f32895d56fc2eee3371589faf680f5d4cc2f22612d`跨语言一致，textures6/geometry1/material1，EXIT0。`test-output/native-wasm-physical-final-identity.json`记录两端逐产物SHA；当前是待最终发布commit与场景画质验收的产物，尚未发布ZIP。
- 追加族回归：Rust contract35、ABI5、scene14项通过；TS src typecheck通过。Runtime Package全族44文件487项通过（含上述59项），覆盖旧包、层栈守卫、规范化、身份及动态场景。Native物理材质GPU只有一个测试，内部覆盖八项目标，不把它计为八个独立测试。

透射按需分配opaque色纹理，首次场景、新增透射材质、环境换代和resize绑定当前源；只在透明pass前复制一次，不从正在写入的颜色附件采样。Stock原240B前缀和默认F0/F90行为保留。非零各向异性、体积厚度和薄膜干涉尚未补齐；它们继续明确拒绝，不能据此宣称全高级材质一致。README不改。

## 大纹理运行包现状核查（21:52）

1. 全仓与未跟踪 runtimePackage、纹理 data、snapshotJson、canonical 消费已查：每个 RGBA 字节被算作 JSON 节点，typed array 限2M；六张2048RGBA实际96MiB会在首图即被拒绝。
2. 契约：纹理 data 原为 numeric array，Rust Vec<u8>；runtime 输入256MiB/node2M/depth32、实际贴图合计128MiB保持。Deep2D/IBL 已有严格RFC4648编解码，不重建编码标准。
3. 依赖：TS已有btoa/atob，Rust已有serde和runtime_base64；无需新依赖。
4. 消费：builder snapshot→资源哈希→package哈希→validator→TS materialize / Rust deserialize；所有路径必须消费相同像素，不能只改Studio前置门。
5. 测试：旧runtime黄金字节/哈希、source specular/贴图回归已有；缺少6×2048实际大图、非canonical padding、越界字节/尺寸/聚合预算验证。旧fixture通过不能覆盖此负载。
6. 规格：本材质一致性及Runtime Package既有canonical v1规格校准。保留旧小numeric黄金；新增大纹理data canonical base64 union，结构预算不放大，图像内容身份仍按解码后的像素。包签名沿用既有wire canonical合同（编码形式属于资源内容，不能静默改旧包哈希语义）。

已有（不重建）：严格base64、GPU像素内容指纹、尺寸/stride/聚合预算、Runtime Package资源/包签名。
真实缺口：大Uint8纹理编码→TS严格解码→Rust严格解码；避免numeric数组/canonical数值展开造成节点拒绝和内存膨胀。新叶已进入上述最终Native/WASM同源构建。

实现：纹理data支持旧numeric array与canonical base64 string，64KiB及以上作者Uint8平面编码为string，mip同源；普通JSON节点/深度与256MiB输入限额不放大。解码前核尺寸/stride和128MiB合计，非canonical/padding错误、共享buffer、访问器、越界字节继续拒绝。既有最后一行无padding的合法stride保持。GPU/CPU像素身份使用解码bytes；包签名继续既有canonical v1 wire合同，历史小包黄金不变。

性能：strictJSON预扫描只对长无转义字符串采用原生indexOf跳过，普通结构/重复key/转义/深度检查不变。生产编译器使用`buildDeepRuntimePackageArtifact`在已验证快照尚未暴露前直接序列化，省去公共serialize的重复整包验签/图像重水化；公共serialize仍重新检查可被外部修改的对象。大图完整build、再验签、serialize、strict parse、还原70项通过（约50秒包括多轮纯JS整包验签，不等同于生产加载耗时）；artifact/黄金/strictJSON/源spec另62项通过，Rust含严格双编码合同共37项通过。六张图的每个源/还原SHA相等，Native真实跨语言加载通过；生产WASM初始化、GPU与帧率仍由Root实测。

## Studio WASM 后台编译现状核查（22:19）

1. 全仓源码和未跟踪项复查：已有studioWasmCompilationClient/Worker和正式wrapper，自17:25已有迁移；Compiler的InProcess名字指worker内执行函数，不能据名称判定主线程。已有链不重建。
2. 契约：输入只含scene、引用的model manifest及irradiance bake；结果Uint8Array通过ArrayBuffer transfer。每候选独立Worker，取消terminate，旧回复不改变新任务。
3. 依赖：Vite module Worker已有；worker无document时browserImageDecoder复用createImageBitmap+OffscreenCanvas；HTTP使用既有viewerAssetTransport带same-origin凭据、signal和120秒资产超时。Draco optimizerIO/WASM加载既有。
4. 消费：正式useAppRuntimeEffects.deepBridges→compileStudioWasmRuntimePackage→Worker→InProcess compiler；WASM Bridge只在worker回包后接Rust。native发布/API worker另有独立后台消费，不移植重复架构。
5. 测试：现有6项primitive字节相等/取消/错误测已有；真实贴图HTTP、后台decoder、transfer、消息解码失败、有限任务超时、进度及无Worker主线程fallback尚缺证据。
6. 规格：本材质一致性、runtime冷热行为和最新用户卡死要求校准，CPU主线程尖峰必须用生产worker采样验证，primitive模拟Host通过不等于真实GPU/大图成功。

已有（不重建）：独立候选worker、终止取消、图像worker-safe decoder、认证HTTP、transfer和Runtime Package严签名。
真实缺口：无Worker时仍回同步主线程、缺messageerror和整体deadline、缺阶段进度、正式browserworker执行证据。补现有链的边界，不重复新建第二编译器。

追加同族核查：正式wrapper仍在主线程调用probeGridBakeForPayload。全仓消费、SceneSnapshot/SceneIrradianceProbeGridBake合同、现有依赖、五项会话测试及本规格核过；已有严格语义哈希不重建，真实缺口是空烘焙会话也先投影和哈希整场景。空Map直接返回undefined可省这一次纯浪费；有烘焙时维持原严格匹配。

实施：正式wrapper只创建module Worker，无Worker环境明确报错；候选取消直接terminate。后台依旧消费带认证的资产HTTP、GLTF/Draco和worker-safe图像解码，再编译、验签和序列化完整运行包；最终ArrayBuffer transfer交回，旧候选消息无效。新增整体180秒deadline、messageerror、严格阶段/结果协议校验和六阶段进度，进度仅由当前switch owner更新。原112MiB贴图预算、advancedMaterials与源材质拒降级合同不变。空烘焙会话直接返回，无整场景投影/哈希。

验收：后台客户端、正式wrapper、生产worker body与引擎切换/恢复五文件33项通过；烘焙会话六项通过（client另重复13项不重复计数），合计六文件39项。生产body测试使用真实GLB与8×8 PNG，走原HTTP凭据/signal、解码器、运行包验签和detached transfer；createImageBitmap/OffscreenCanvas在Node测试中提供API桩。Web typecheck通过。日志为`studio-wasm-worker-complete-final.log`、`studio-wasm-empty-bake-final.log`及`studio-wasm-worker-typecheck-final.log`。正式浏览器Worker加载、实际SMT大图与主线程响应仍待同入口采样；Rust WASM注包/启动的重复解析是独立后续热点，尚未在这次Worker边界改动中处理。

## Draco 按需初始化现状核查（22:46）

1. 源码及未跟踪文件：normalizeStudioModel仅对Draco模型调用optimizerIO，当前却同时预载encoder/decoder/Meshopt；每候选worker独立缓存，重复切换重复分配。
2. 契约：归一化应仅移除压缩扩展，保留几何、材质和纹理；WebIO已有ALL_EXTENSIONS，Draco读依赖decoder、写依赖encoder，移除Draco后写出不再需要encoder。
3. 依赖：draco3dgltf1.5.7、meshoptimizer1.0.1均已有。两份Draco wasm内存节各initial16MiB/max2GiB，Emscripten错误包装与真实UI的Aborted(RangeError…)一致。
4. 消费：optimizerIO供正式模型优化/压缩，normalizeStudioWasmModel供WASM编译Worker及WebGPU author decoder Worker；后者只读压缩资产，不能全局取消encoder。
5. 证据：dev-smt-wasm-worker-startup.json每5秒两次重复start/module-ready，未到package-compiled。mainthread40.75秒采样idle25.28秒，无主线程包编译热点，不能据此区分encoder还是decoder实例失败。现有优化/材质测试已有，缺decoder-only初始化及真实Draco读写材质/纹理守恒。
6. 规格：本后台编译与材质一致性要求保持；生命周期自动重启由另一任务修复，本叶只改必要codec实例，Rust不改不重建。

已有（不重建）：WebIO、扩展登记、固定codec、压缩任务encoder和严格源材质消费。
真实缺口：归一化额外实例化encoder与无关Meshopt。按输入扩展按需decoder/Meshopt，与正式optimizer共享同realm codec缓存，保留其压缩能力。

实施与证据：归一化切到现有IO文件的modelDecoderIO，单Draco输入只初始化decoder；仅声明EXT_meshopt_compression时动态加载Meshopt。原optimizerIO仍提供完整编码能力，两入口复用decoder/encoder缓存并在失败后可重试。ALL_EXTENSIONS未缩减，Draco移除后正常写出；不改变解码几何预算或材质合同。

五文件17项通过，涵盖原优化、旧材质和生产Worker；再加强冷解码实测两文件六项通过。真实Draco wasm编码生成压缩GLB后，生产归一化只fetch decoder，createDecoder1/createEncoder0；源贴图bytes完全相等，BLEND/透射1/高光factor及两贴图引用保留，节点/网格/顶点/索引数量及位置包围盒一致。glTF写出允许texture索引重排，验收比较资源引用及像素，不错误要求新索引必须为0。最终Web typecheck通过，日志`studio-decoder-only-focused-final.log`、`studio-decoder-only-cold-final.log`、`studio-decoder-only-typecheck-final.log`；只读profile及wasm内存节证据为`studio-decoder-only-diagnosis.json`。正式SMT一次冷切换/OOM消除仍待生命周期修复后的真实浏览器复测。

同一真实模型随后交回正式optimizerIO再次Draco压缩成功：实际encoder实例一次，decoder复用一次，压缩扩展正确写入。此追加测试六项仍通过，未改冻结生产叶；新的测试行由下一次统一Web typecheck纳入。

## 实际 WASM 空图现状核查（23:05）

源码/未跟踪链、RenderPacket/RuntimePackage/PlayerContent合同、现有依赖、Worker→Rust注包→prepare→spawn→mesh消费、实际marks/截图/CPUprofile及本规格已核查。正式单次启动43.925秒（Worker32.781、Rust/GPU11.094），重启/OOM消失但SMT空图，published不作为几何成功。当前world camera(2.3041,8.6796,21.8094)、target(0,3.6,0)，local origin为0；已存在world/local live camera合同缺口，但不能作为此次空图归因。

已有（不重建）：Rust真实packet消费、几何/材质合同、候选Worker和完整校验；5197/5198/5199证据接收端仅支持JSON GPU结果，不支持直接大二进制运行包。
真实缺口：实际134MiB包尚未落盘核对mesh/instance/camera，需要零主线程JSON.parse的流式receiver。仅测试目录添加固定本机端口、256MiB上限、固定产物目录的raw bytes接收器，流式计算SHA，不引入生产API或用户场景写入。

## 初始骨骼姿态烘焙现状核查（23:26）

1. 全仓源码和未跟踪项已核查：decodeDeformablePacketGlb 的非 live 分支只剥离 skin/morph；没有应用初始关节与 inverseBindMatrices。已有 CPU 蒙皮、形变和组合内核不重建。
2. 契约：RenderPacket 几何位置/法线、UV0/UV1/切线/索引、独立 instance.pose 与 RuntimeGlb instanceProjection 已存在；静态包必须含最终形状，不能留下未消费的 pose。
3. 依赖：GltfRenderAnimationBridge 已计算 meshWorldInverse × jointWorld × inverseBind，并提供初始 morph 权重。现有 CPU packing/kernel 已在 GPU 对照和 Three bridge 测试使用，无新增依赖。
4. 消费：Studio Native/WASM 运行包和模型 Worker 共用该导入器；WebGPU live 宿主逐帧覆盖 pose，保持其现有行为。
5. 证据：真实回包156,053,809B，SHA 4b138c43437463f486a5d8083d18d634f404892bf47670917566a48737a51bc9；3个SMT实例134,470三角形均存在，但世界x边界约[-57.7445,-44.7985]，相机target为0。旧测试只断言 deformation 被移除，未校验姿态位置。Three 的适应场景也追到错误原始边界-51，证实未变形边界与显示几何不同。
6. 规格：按真实三引擎姿态/材质一致性及当前空图要求修；仅修改导入与初始姿态 CPU 叶，由统一 Core 构建纳入，Rust包/GPU算法不改。

已有（不重建）：运行时解码、节点世界变换、关节调色板、CPU morph/skin 内核及材质贴图合同。
真实缺口：静态导出未烘焙初始形变；复用已有内核按实例生成独立静态几何，保留根变换及所有非位置流，限制总内存并保留取消。不能可靠解码的变形扩展明确拒绝，避免继续输出错误几何。

实施验证：初始 morph、非单位 mesh/joint/inverseBind、非均匀法线、多实例独立姿态、材质/双UV/像素守恒及取消/预算10项通过；GLTF相关31文件291项通过，Core/lab/examples类型检查和统一构建通过。QA项目的实际GLB SHA0317b3e47f0742734ea6da981bacc652cb088aaa7242ae96e59c9fa066af702d，共134,470三角形。独立Three GLTFLoader.applyBoneTransform给出世界x[-26.9618473,31.2889099]，烘焙结果最大边界误差5.50e-7；全部材质及六张2048像素SHA烘焙前后相等。报告smt-initial-pose-audit.json，源/产物叶identity80fba64a5aeae380d21a79a3d9b7132b082649a063e9ac957ce6407117eee4e2。浏览器实景由Root随后复测。

## WASM 已验证资源复用现状核查（23:37）

1. 源码/未跟踪项：set_scene_package、update_scene_viewer先严格解析后丢弃，复制整个156MiB字节；start和WasmScenePackage事件再严格解析，属于同一拥有者内的重复工作。
2. 契约：已有LoadedRuntimePackage与PreparedRuntimePackage，PlayerContent持有最终像素/几何；外部输入仍需唯一字段、JSON预算、v1 canonical签名和材质/纹理验证。Prepared对象不能重新接收未验证字节。
3. 依赖：serde_json/wasm-bindgen/winit已存在；仓内没有RuntimePackage二进制或sidecar场景入口，Three OffscreenCanvas不等于Rust HtmlCanvas消费路径。
4. 消费：set→start和update→event两个正式入口可直接移交已验证Prepared对象；Native文件/恢复载入仍走现有严格入口。
5. 证据：真实第二次update有3个longtask共9612ms；读取CPU链证实至少两轮包校验，每轮unique Value解析和schema重解析，附加canonical整串与多次156MiB复制。当前没有仅第一次严格解析耗时数据。
6. 规格：持续修复卡死与冷/热切换要求；不扩大timeout和输入预算，不改RuntimePackage发布版本。先消除重复解析和字节持有，再用实际时序决定后台验证/内部资源移交。

已有（不重建）：严格运行包验证、Prepared内容、同一canvas事件循环和后台编译Worker。
真实缺口：内部丢弃校验结果；待set持有Prepared对象、start一次性take、update向事件直接移交Prepared对象，取消后不持有原大JSON字节。单次严格解析仍是主线程风险，不能将该窄修等同于冷启动全部达标。

## 作者运行包异步构建现状核查（23:52）

1. 全仓构建/哈希/未跟踪叶已核：buildDeepRuntimePackageArtifact复用公共同步builder，先生成两份大canonical SHA，再由公共validator立即重新计算同两份。
2. 契约：v1 canonical二进制浮点数字/Unicode键序、严格snapshot、RuntimePackage索引和像素预算已有；公开同步构建/验证/序列化仍须完整重验可变外部输入。
3. 依赖：浏览器/Node已有WebCrypto；当前pureJS SHA每份大资源约4.2秒，新原生digest可复用相同canonical bytes，不新增依赖或发布格式。
4. 消费：Native/API及WASM Worker共用async compileSceneRuntimePackage，已有后台Worker不重建；新增异步artifact入口仅用于私有尚未暴露的拥有者快照。
5. 证据：真实UI package→complete33.1039秒，其余starting→package2.0057秒。单核Node真包snapshot约1.2秒、canonical约1.15秒、SHA约4.24秒，四轮合计27.8秒；native SHA81–84ms且同digest。同canonical用一次DataView复用从1146降至562ms，字节及5项黄金相同。
6. 规格：按作者性能要求消除重复验签；异步前取得全部作者输入所有权、保留结构/材质/纹理验证，公开API不接收“信任输入”开关；取消后不发布或缓存半成品。

已有（不重建）：严格JSON快照、canonical/hash合同、结构/资源校验、异步编译消费者和Worker。
真实缺口：内部owned构建重复快照/重验刚产生的hash，以及pureJS大字节SHA。新增owned异步artifact用两次原生digest，结构检查复用同validator；同步公共路径保持原外部验签。

## 2026-10-08 工程交接安全点

用户转为“视频继续，其他写交接文档”，停止新增工程优化和最终发布包构建。

异步 owned artifact 已完整接入正式 compileSceneRuntimePackage。构造器在首次 await 前取得源几何、材质、拾取绑定及其他资源的快照；使用相同 canonical 字节的 WebCrypto SHA，内部仅复用自身刚产生的 digest，全部结构、资源、材质和纹理预算仍检查。公开同步构建、外部验证与序列化保持重验。两文件59项通过，包含新路径与公开 wire 完全相同、源数据异步期间变更、取消和恶意材质；正式编译消费者29项通过。Core/lab/examples 与 Web typecheck、Core build、runtime purity、source-size（3495文件、0失败）通过。Core dist 已更新，新导出可解析；没有执行新生产浏览器性能回归。

Rust owned Prepared 修改已完整落盘：set 持有严格解析后的对象，start 一次性移交，update 通过事件移交，去掉同一包的再次解析与大字节 clone；JSON 树直接移入 serde schema，保留 duplicate-key、深度/节点预算与 hash 检查。WASM cargo check 与 stage release 通过。七个 Native integration targets 共52项通过、1项失败、1项忽略；失败为真实 X/LPAC 子进程退出0xc0000022，未处理。新 JS/WASM 仅在 test-output/wasm-owned-stage，未替换 apps/web/public/engine-wasm；Native EXE 尚未按新 Rust 源码重建。

仍需恢复处理：真实旧路径 package→complete33.1039秒、WASM主线程约9.6秒阻塞尚未以新包生产验收；单次严格 Rust parse/hash 仍在主线程。159,919,627B真实SMT包超现有64MiB缓存准入，作者语义键的有限单槽重用尚未实现。真实初始姿态与 framing 已通过浏览器验收，但 WASM 背景、网格和 IBL 仍有三引擎差异；最终 Windows/SDK/Docker/Release 不具备冻结条件。所有源、dist、stage/public身份及恢复命令见 test-output/studio-runtime-owned-handoff-identity.json；私有模型和运行包只留本地 test-output，不提交。
