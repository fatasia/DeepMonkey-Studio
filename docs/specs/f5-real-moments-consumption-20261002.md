# F5 真实 moments 消费链 — CPU 方案（2026-10-02，先行）

> 前刀最终证据 `f5-final-webgpu-verification-20261002.md` 与总receipt已收口，F5开放。此刀不引入亮度比遮挡、不改原门、不碰F6/历史/API。GPU等待主线程F6窗口释放，当前只CPU核查/实现。

## 现状核查（六步）

1. 全仓检索含未跟踪：storage sampler有96B `IrradianceProbeRecord`（radianceValidity/visibility/relocation），texture sampler仅rgba16float无moments；当前完整16点moment变更对storage有3.70283响应，对product texture为0。
2. 合同：`ProbeClipmapResources.probeStorageBuffer` 已分配96B×capacity、使用STORAGE|COPY_DST；resource通过 `ProbeCaptureBeginContext.resource` 已传入 capture hook。**无需扩WebGpuProbeRadianceContext**就可复用这个buffer。原初查说context不能拿到buffer过于粗疏，已按嵌套context纠正。
3. 依赖：vitest/esbuild/tsx/naga已有，无新增库。捕获producer、adapter与资源池已有事务机制。
4. 消费：producer→capture/filter→adapter.commit→runtime.snapshot→controller→ForwardPlusPbrLightingBindings→product fragment全链已读。moments写入/发布真正缺失。资源只给relocation写零radiance/validity，不能当已有实时moment数据。
5. 测试：资源、adapter、producer、绑定、capture pool、texture sampling、storage checksum门都有；前刀完整11/12原矩阵失败和四历史家族失败保留。
6. 规格：前刀/L4/L5/frame ABI/root只读。此文件先写再动手，不用注入或CPU静态数据冒充producer输出。

## 已有（不重建）与真实缺口

- 复用96B storage record原口径：visibility.x=命中距离均值，y=命中总体方差，z=miss占比；relocation.xyz原样保持。CPU/WGSL公式同一契约。
- 真实缺口：capture核未产moments；filter/publication未携带；片元绑定无moments通道；相机移动/rollback/重捕获必须与radiance同代。
- group3现有8个fragment storage已满，**不得草率加第9个storage并声称零容量影响**。应走moment texture（unfilterable float），不增加fragment storage预算。

## 方案（root 已确认原范围内内部接线）

1. compute capture核也已经8个storage满额，不能直接新增第9个record绑定。采用可选`rgba32float` storage texture输出mean/variance/miss/valid；默认kernel不变、Native旧wrapper继续调用默认8storage变体。Welford只累加命中距离；全miss→tMax/0/1，overflow/buried→valid0。默认32B ProbeParams/576B uniform不改。
2. adapter新增事务私有raw/filtered moment volume（rgba32float、单mip），moment export pass只用2个read storage+1个RW storage（既有96B resource）+1 uniform+2 textures；写96B radianceValidity/visibility两个vec4，保留relocation/保留stride，再把统计发布为片元texture。scratch不供片元直接消费。moments不做未经证明的邻居平均/时域hysteresis。
3. capture context仅新增内部可选moment destination view、runtime option内部`captureVisibilityMoments`，product factory启用；SDK无moments默认仍旧texture行为。publication/lighting仅内部可选view，b16空槽（0..15已用）作unfilterable-float moment texture，不改packages/contracts。
4. 同代moment.w采用三态内部标识：0=旧fallback无moment（保留旧texture权重）；1=真实有效；-1=真实捕获无效（拒绝，不能静默旧权重）。no-GI绑定1×1零moment纹理，domain metadata零，避免新增开关公共合同。
5. 生命周期：raw只供本txn；output复制上次同grid key且metadata origins相同的committed moment；网格移位/resize/initial清invalid；capture完→export写目标→queue retirement→commit同时发布radiance/moments。rollback/abort只回收本txn，不改变旧visible moment；device-loss退役并释放全部pending/committed/pool；复用池warmup后有界。moments maxTransient预算=旧radiance双volume+raw/output两moments（16B/texel），不抬device limits。pool按format/key区分，不得rgba16/32错用。
6. texture 8-tap乘既有Chebyshev合同（finite/variance floor/enclosed判据/bidirectional delta），RGBA辐照仍原sample，moment无效拒绝。同代raw moments不是CPU注入估计。default texture ABI的新binding也要核所有lab/prod consumers提供fallback，静态可达入口组合单独naga，Native共享storage WGSL及旧捕获默认无改。
7. 片元budget核查：group0 spec/diffuse/DFG/local×2=5纹理，材质5、shadow legacy+CSM/local+probe/area=5，共15；moments第16纹理正好default上限，storage仍8；不允许额外抬limit。textureArrays/变形/layered组合按既有feature可达性与limits列明，禁止说所有高阶组合已验。

## 边界与最低测试矩阵

- 全miss/全命中/单命中/Welford极值；maxDistance近边界；negative/NaN拒绝；spatial层索引与layer flatten；overflow/buried保持alpha0；relocation不覆盖；moment texturefloat32避免f16μ²溢出。
- initial/none/scene dirty/camera grid move/resize/device epoch；submit取消/validation失败/迟到事务/旧owner dispose；resource容量缓存换代，zero pending不重复分配。
- CPU fake-device接线+shader naga；真实moments改动对产品采样产生变化、与原storage/CPU在同record/同receiver对拍。原sealed三域/4GIoff/动态/室外/12项矩阵不改（即使仍失败如实）并新增真实moments责任证据。

## 实施与验证（最终同源子集）

**用户可用范围**：现有 Deep WebGPU GI 打开后后台自动捕获/发布真实moments，没有新增页面、设置控件或操作步骤。无moments SDK路径保留旧采样；Native未镜像此纹理发布链、cargo禁用。不把moments子集完成当作F5整项关闭。

### 实施叶

- `rayTracing/probeRadianceKernel.ts`：可选moment emitter（Welford命中均值/总体方差/miss占比），不改576B uniform/32B ProbeParams/96B公共record；默认无新binding，compute storage仍8。
- `rayTracing/probeSceneRadianceProducer.ts`：可选moment destination时lazy pipeline（rgba32float输出），默认pipeline保留。
- `webgpu/webgpuProbeCaptureTypes.ts` / `webgpuProbeCaptureAdapter.ts` / `webgpuProbeCapturePool.ts` / 新`webgpuProbeMoments.ts`：事务raw/output moments、96B scratch留relocation、sameGeneration commit、rollback/迟到retirement/deviceLoss池释放、类型/format隔离、grid shift拒旧同槽history、预算钳制。
- `lighting/probeClipmapTextureSamplingWgsl.ts` / `pbrLightingBindings.ts`：group3空b16，不增storage。真实moments维度在场时按原storage的worldPosition插值坐标与0.001weight threshold；no-moments1x1 fallback保旧receiver偏置坐标与>0判据。
- `probeClipmapRuntime.ts` / `pbrRenderer.ts`：内部option透传、产品既有GI工厂enable；未改contracts公共类型与UI。
- 所有实际consumer（`lab/probeClipmapCaptureProbe.ts`、`scripts/t02ProbeTextureSamplingPageKernel.mjs`）补b16零fallback，不能漏装配导致Dawn缺绑定；默认旧SDK不伪造Chebyshev。

### CPU / naga / 类型

85聚焦/naga通过（后新增cancel/device-loss两例另16/16）；最终lighting/rayTracing/threeBridge/webgpu **2950/2950，0skip**。src tsc exit0。lab tsc当前exit2，精确两项已移交B1：`deepSlPbrGpuDrawSupport.ts:54` Float32Array<ArrayBufferLike> vs ArrayBuffer；`deepSlPbrProbe.ts:130` instanceStride160|144 vs144；不宣称配置全过。四历史红已由主线程完全修复，此处不再用旧失败归因。

### 同源真GPU双fresh（没有计时）

最终`accepted-source/round{1,2}` **1187个非node_modules依赖SHA前后stable**，同bundle `c44d733b7a86a9c2f8aabc9d1012dee474f7d266fcc3892f310eab261468b23e`；NVIDIA Lovelace、Chrome154，所有产品pageErrors=[]，revision前进/捕获泵drained。favicon404为harness资源日志保留，不冒称控制台全零。40主/步进截图+82流帧全保留，6张无裁切contact sheets逐张Read。

- 全卷真实捕获：open142有效+6002invalid，sealed141有效+6003invalid，moment absent=0、全finite；moment view身份与product绑定一致，meanMax5.572/5.092，varianceMax15.075/10.529，missMax0.90625。
- 真实捕获来源的完整16点texture灵敏度 **3.85705**（前刀0），与同records/storage/CPU对拍texture最大误差 **4.8843e-5**（rgba16输入量化）、storage误差9.54e-7，queue/shader0。注入对比只证可达与数值消费；真实moments是否准确以全部capture oracle另裁，不能把灵敏度当整场物理通过。
- oracle完整142/141点：miss占比全精确；两点`[8,0,-2]`/`[8,0,2]`gpu mean/variance=0而CPU mean0.0351648/variance0.0074194，maxRelative=1，**如实失败不删点**；其余内域最大mean1.63e-7/variance6.58e-7仅diagnostic，不能拿删点结果关门。边界射线CPU定位后续，原完整receipts保留。
- 原三域阈值/rect不改：最终round1 ratios **-87/-337/-3**，round2 **-85/-336/-3**；open R≈-0.07/-0.11/0.02分母仍退化，不能过門。动态A/B 206.13→196.14、恢复MAE0.00327/0.00319，仍非严格逐位；既有room原质门不闭。
- 四张GI-off两轮对前刀raw像素恒等；外景/动态邻居全部量化`accepted-image-audit.json`，不只采点。两轮visual没有新增大黑斑，但物理正控制未建立，不能宣称95%画质。

### 资源与默认兼容纪律

默认捕获kernel no-moments8storage/旧binding在测试/naga确认；默认kernelSHA `992873a7306b4d18189a6956a509e34e361ffdde018e7508b261a1eca735ccf2`。HEAD还在L3阴影之前不能作default字节比较基线；不虚报与旧HEAD逐位。真实moment texture每格16B，没有提高device limits；峰值池budget和纹理上限在CPU验证。全scope新叶≤400，adapter375行，不拆无收益抽象。

## 子集与整项裁定

- **真实moments生产/同代发布/texture可消费子集：已落地且真GPU双fresh可达验证。** 它不是遮挡正确性的万能证明。
- **F5整项：开放，不放门**：原三域比值仍退化、原12矩阵质量门未关、完整moments oracle两边界失败、动态严格恢复、Native未认证/未cargo、帧时未测。
- 下一步只做CPU完整域逐射线边界定位，禁止删点/加epsilon伪修默认kernel或改public ray contract；sealed正控制必须后续完整合法验收，不能用亮度比替代。
- 对用户体验没有新UI/步骤；GPU窗口已释放给B1，后续不争用；不commit/push/reset/clean/stash。

## 全域CPU边界射线定位（GPU窗口交B1后，零生产改动）

复用原fixture函数与生产`compileSceneRenderPacket`→`CameraRelativeCoordinates.localizePacket`→`buildRenderPacketRayScene`，对已落完整open142/sealed141域×32方向逐射线，原两点全部留下。`cpu-boundary-rays.json`含全域记录与每态14个边界射线三角诊断。

精确根因不是excludeSelf、epsilon或新增moments公式：

1. 两点在室外ground盒的`x=8/y=0/z=±2`边缘。ground的CPU worldToLocal逆矩阵y尺度`19.999999701976783`、平移`-1.0000000000000002`，CPU局部origin y比-1略低；GPU打包f32变为恰-1。
2. ordinal9：f64 Möller–Trumbore侧面`v=-1.1102230246251565e-16`或底面`u+v=1.0000000000000002`，依既有严格u/v边界拒绝t≈0的面；CPU转取顶面worldT=0.24615384982182426。
3. f32逐运算模拟相同三角`v=0 / u+v≤1 / t=0`，符合共享`WGSL_HELPERS`的t≥0接受语义。原GPU实测moments mean/variance0与之吻合。7个命中中CPU一条0.24615385→mean0.0351648357、variance0.007419394，解释全域两点差异，miss比例不变。
4. `bvhBuilder.intersectTriangle`注释称单精度语义，但实际JS运算未fround；CPU oracle与packed f32 GPU在精确边界不等价，不能拿相对误差掩盖或删点放门。

**处置**：只定位、不改公共射线合同或默认kernel、不加epsilon、不排除原点。完整原oracle仍记失败。正确后继应建立同packed-f32输入/运算的诊断仲裁或精确边界定义与解析第三腿，经root裁定后再完整复测；本刀不把f32模拟当真机逐射线替代。原sealed正控制依然缺失、F5保持开放。

## 独立packed-f32全域仲裁与正控制机制（只诊断，不替原尺）

- `packed-f32-boundary-diagnostic.mts/json` 从实际 `packTlasScene` buffers反解全部f32矩阵、顶点、BVH盒，逐操作fround镜像共享cross/dot/strict barycentric与TLAS/BLAS slab、相同左右栈顺序、32方向表。**完整open142/sealed141，没有删原盒边界**。最终mean最大相对1.533e-7/1.430e-7，variance7.821e-7，miss差0，producer统计可由GPU输入/操作解释。
- 首版brute-force忽略packed BVH剪枝，mean/variance近似吻合却miss最大差0.90625；原失败存`packed-f32-bruteforce-first-diagnostic.json`，补完整剪枝才解释缺席；不把首失败删掉。新诊断不是公共CPU ray替代，也不认证真机逐射线HitRecord或关闭原f64相对1两点。
- `positive-control-mechanism-audit` 全142/141域按当前同态producer锁存分解（不改源/env/material/机位）：capture含主方向Lambert+该主光shadow射线、miss常量ambient；**不含material emissive、point/spot/area、命中面环境diffuse、方向辐照lobes、多跳feedback**。这与概括“GI”不同，不新编合同补位。
- 同态ambient `[0.00332054,0.00665439,0.00863770]`；open4544条ray含2810miss/1734hit/479sunVisible，sealed4512条含2796miss/1716hit/462sunVisible；全部统计留证。每态992条t=0主要在ground表面，不能误判moments坏或偷偷删源。
- 信息性室内子域6格（只是全域报告分组、非另挑验收点）：open hit反弹均值 `[0.0108194,0.0091220,0.00660056]`、sealed hit/miss都0，而显示冻结三域openGI delta几乎0。正控制并非完全没有可见主光源，而是**均匀球面首次命中radiance均值被当作法线相关diffuse irradiance、与环境diffuse替代基线相减**的量纲/方向能量合同缺口；不能盲乘π/4π或削环境来追绿色。原32shadowed-MC误差55.89%依然开放。
- 起初误取boot锁存ambient0的CPU分解原证另存`positive-control-boot-zero-ambient-first.json`，改读interiorOpenOn/interiorSealedOn同态锁存后数据见`positive-control-latched-audit.log`。不把boot旧数据称真实光照当前状态。
- 同包动态A-on−A-off/B-on−B-off只约R+0.504/+0.632、蓝为负；绝对A→B~10/255下降带直接shadow变化，不能充当间接反弹衰减证据。

**下一真实动作**：先按已有radiance/irradiance基准明确被捕获功能量与receiver显示消耗的转换/方向内容（复用现有高采样reference，不改原sealed矩形和门），增加source/emit局限的同源证据；任何新物理能量桥必须先方案/授权并同时保持原质量门与新增诊断，零UI操作增量。当前不改默认kernel或公共ray，F5整项保持开放。主线程J3持有GPU，后续CPU诊断不争用。

证据：`test-output/f5-real-moments-consumption-20261002/accepted-source/`、`moment-diagnostic-round{1..4}/receipt.json`、`chebyshev-moment-consumption-round{1,2}.json`、`moments-consumer-aligned-round*.log`、`final-cpu-family.json`、typecheck日志、`final-source-receipt.json`。


## 第一路收口补充（2026-10-02 主线程代完成）

- 解析 oracle 落盘 `lighting/probeRecordIrradianceSemantics.test.ts`（5 例）：常量场巧合相等（白炉门一直绿的解释）、半球场朝法线显示丢一半、水平巧合、朝下漏 L/2（sealed 室内漏光解析同族）、黑 albedo 负控。把"记录=4π 均值辐射、消费=当方向辐照度 E(n)"的语义差距钉成确定性回归证据。
- **方向消费修复需要公共 96B record 扩展或内部方向 atlas 设计裁决**（L1-SH 截断能否满足原 32 方向 ≤10% 门未证；octahedral 方案需纹理预算核算）——按"新立项先问再实施"留用户拍板，不擅自扩合同。F5 行保持开放：原 sealed 比值退化、原 12 矩阵 11/12、动态严格恢复、Native 未认证、帧时未测全部原样保留。
