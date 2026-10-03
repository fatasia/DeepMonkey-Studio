# F6 布料与软体续接核查（2026-10-01）

本批补既有固定步求解器与静态场景碰撞的最小消费链。状态：静态碰撞第一片已由 root 提升并复跑正式 CPU；显式顶点映射草稿已验证，等待根路审查。

## 现状核查

1. **源码与未跟踪项**：全仓 packages/apps/src 检索 cloth、softBody、collision、stream，并读 git status。已有 ClothSolver/SoftBodySolver、softBodyRuntimeHost、串行和着色并行 GPU dispatch；当前 physics 目录无在途修改。现有 deformation/morph 不是软体 readout 的消费证明。
2. **合同**：已读 contracts/scene.ts、physicsTypes.ts、runtimePackage/dynamicSceneRuntime.ts。ScenePhysicsState.softBodies 与 cloth/soft-body 判别联合、固定 1/60、预算、风、groundY、fixed primitive collider 和初始 pose 已有；不新增第二套序列化合同。
3. **依赖**：Web 已有 Rapier 0.19.3；Native Rapier 0.35.3、wgpu 30.0.1；引擎已有 WebGPU 类型、Vitest、TS。此切片无新增运行依赖。
4. **消费方**：compileScenePhysicsRuntime 下译→运行包解析→createSoftBodyRuntimeSession→真实 solver.step/readout 已可执行。GPU auto dispatch 默认 parallel-first、设备管线缓存，缓冲逐调用创建；会话内锁核和缓冲复用仍缺。Web 查看器无正式 readout→形变消费；Native 对 softBodies 明确拒收。
5. **测试与证据**：已读 T18-implementation、F6-物理高端特性生产接线、F6-遗留切片-scene到运行包软体译层；softBodyRuntimeHost.test 已覆盖风旗、软球 groundY、回放与预算。已有 cloth-parallel-gpu-20260929-r1/evidence.json、两端 WGSL parity fixtures 和 dispatch 编排测试；历史 A3 核证据不等于当前生产换核全 substeps 复验。
6. **规格**：remaining-tasks-estimates-20260930 的 F6-A3 4–8h 与 F6/T18-collision 12–24h，core-capability-development-plan-2026-09-27 §T18、active-task-recovery-ledger 已核对。布料拉伸≤5%、软体体积≤5%、固定步回放门保持。09-22 expansion handoff 未在当前仓找到，以真实 09-27 主计划与 remaining 为准。

### 已有（不重建）

CPU XPBD 布料/四面体约束、确定性风、锚点、groundY 两次投影和速度回算、快照、作者→运行包、SDF 查询/提取桥、Rapier、GPU 串行/并行核与 ABI。

### 真实缺口

- 非地面场景障碍没有进入布料/软体每子步接触；静态碰撞、动态双向互碰、自碰撞必须分开登记。
- 位置流未被发布查看器网格消费；不能把 readout 返回数组称为生产形变接线。
- GPU parallel 的生产入口换核全 substeps/重放口径和持久缓冲仍待复验；软体 GPU 并行另缺。
- Native 尚不消费 softBodies；跨端完整软体能力仍开放。

## 第一刀：显式选择的静态 primitive 接触

复用 fixed body 的 primitive sphere/cuboid、initialPose；session 增可选 collisionBodyIds SDK 参数，未选择保持原默认。选中未知/重复 id、非 fixed、未知形状与非法参数明确拒绝。不修改 RenderPacket/runtime 包 schema，不碰 Rapier 刚体系统。

独立 helper 建一次只读几何、固定 id 顺序，每子步积分后与 XPBD 约束后投影活动粒子，随后沿原速度回算。锚点不动。sphere/cuboid 为点粒子对实体的离散无摩擦接触，不承诺 CCD、厚度、 restitution/friction、双向冲量或移动障碍；高速度跨过实体仍由后继 CCD 处理。多个障碍使用固定预算迭代，无法满足接触则报错，不静默穿透。

锁定草稿：clothSolver.ts、softBodySolver.ts、softBodyRuntimeHost.ts、physics/index.ts；新 softBodyStaticCollision.ts 和独立聚焦测试，各新叶≤300。所有草稿位于 test-output/f6-continuation-20261001，before SHA 入 manifest；正式提升由 root 审核。

## 准入与证据

- 实际 solver/session CPU：未启用逐位基线、两 kind 静态球/有限盒接触、旋转/平移、锚点、固定 seed 双跑、capture/restore、选错 collider/非法几何/不可满足接触负例。
- 在预登记 fixture 上每 tick 检查接触，布料全约束 maxRatio≤0.05、软体 totalRatio≤0.05；失败保留，不能用降低重力或更换资产追结果。
- 同族原 solver/session/译层测试与独立 typecheck；CPU 不冒充 GPU 或 Native 复验。
- parent 统一 GPU/Cargo；此次切片不关闭 F6/T18-collision 或 F6-A3 整行。真实网格消费、动态耦合、SDF/mesh、GPU 会话与 Native 继续单列。

## 本轮 CPU 草稿结果与冻结

2026-10-01 20:10 正式集成：root 已核冻结 manifest SHA `757cd72049fcf434c9ed6abae3685658c72ce1cb75e8759d7ae6412b7c1c0de0` 与六项 before/after 后提升正式源，保留旧字节备份。正式四文件34/34回归、SDK src/lab/examples 完整 typecheck 通过，收据 `test-output/jc-i-20261001-f6-promotion.json`、日志 `jc-i-20261001-f6-formal-cpu.log`、`jc-i-20261001-i23-f6-typecheck.log`。静态接触范围通过，停止重复该 CPU 门；真实 body→geometry 变形消费继续补缺口，F6 整项未闭。

草稿已冻结于 `test-output/f6-continuation-20261001/manifest-frozen.json`：4 个既有叶的 before SHA 仍与正式源逐值相同，新 helper 107 行、新测试 169 行；clothSolver 286、softBodySolver 297、runtimeHost 163、index 19，均≤300。正式生产源未修改。

- 4 文件 **34/34 CPU**：原 cloth 10、soft-body 7、session 5 与新增 12。独立候选源码 tsc 与新增测试 tsc 均退出0。
- 240 tick 风旗：实际 finite box 最大拉伸 **0.2557901535%**，sphere **0.4184340961%**；原门5%。实际启用输出与同参数禁用接触输出不同，每 tick 接触验证，锚点 xyz/velocity 保持，双跑与快照回放逐位相同。
- 180 tick 四面体软球：box 最大整体体积误差 **2.1071238010%**，sphere **2.1495680227%**；原门5%。每 tick 接触、速度回算、双跑与回放通过。
- 默认关闭全六 SoA lane 与修改前正式代码的 180 tick 指纹一致：cloth `c9ef041b7e3c41d3`、ball `1b4fc5cb0e159383`。golden 来自正式 before 源，日志 `formal-baseline-before.log`，不是候选自行生成。
- 原夹具 8 列/底 y=.05 的旗没有实际接触：加入禁用负控后两项真实失败，`cpu-contact-control-failed.log` 保留。接触夹具独立登记为 9 列（含球顶 x=0 接触线）、底 y=0、顶锚[63,71]；重力、风、质量、substeps、5%门均未变。该改动补接触可观测性；旧绿不计接触证据。
- 同时 groundY 与 collider 不可满足时明确失败；不破坏旧 groundY 不穿透合同。两次位置投影仍在原速度回算前，未增加新时间或状态机。

### 支持域与数值边界

刚体运行合同没有 scale：仅消费 primitive 半径/半尺寸（米）与 initialPose 平移/四元数；不会把模型非均匀缩放 sphere 当 ellipsoid。直接对象额外 scale 拒绝。盒子在归一四元数 OBB 局部投影，并有“world AABB 内、实际 OBB 外”的不移动负例。球中心确定选 +X，避免除零。投影后保留全原几何检查；`32×Number.EPSILON×operandScale` 是 binary64 旋转/平移/范数舍入的声明边界，不是粒子厚度或经验穿透容差。多个 obstacle 超过4 sweep 未满足、groundY 被破坏均拒绝，未吞错。

该数值边界未经过全部极端坐标的形式化证明；实际验收覆盖单位米与平移旋转、非法非有限/非正域，不能据此宣传任意尺度接触。CPU helper 无每粒子新数组/对象分配，障碍准备一次，迭代预算固定；大规模接触吞吐与 broadphase 优化尚未实测。GPU/Cargo 均未执行。

## 顶点流下一片现状核查（独立草稿）

1. 全仓关键词与未跟踪项：physics readout 仅 delivery 测试消费；Viewer/production 未接软体流。现有 deformation 管线只含 morph/skin/morph-skin，不能借其标签冒充 cloth。
2. 合同：GeometryResource 是 xyz+normal 六float流、revision、indices及UV/tangent/color；RenderInstance 有 geometry、transform、pose、lod。SceneSoftBodyState 只有 body id/粒子，无 geometry/instance 绑定；因此新增 SDK 显式 bodyId→instanceId→vertexParticles 映射，不改发布 JSON。
3. 依赖：复用既有 scene/math.invertAffineSceneMatrix、gltf/generatedNormals.generateNormals、RenderPacket、PacketBuffers.set/MeshBuffers；无需依赖或 renderer。
4. 消费：PbrRenderer.setPacket→PacketBuffers.set→stagePacketBuffers→MeshBuffers/uploadBuffer 是真实资源更新链。几何 revision 增长会替换该 mesh、更新 bounds、释放旧网格，未变实例/材质可复用；不是原位流更新，motionHistory 会重置。
5. 测试：已读 packetBuffers.test.ts 的资源所有权/未变复用/上传失败回滚；用同族 fake DeviceSession 只检查真实生产资源编排与字节，CPU 证据不等于 GPU 画面。
6. 规格：继续属于 remaining F6/T18-collision 的顶点流生产消费；原5%和运行包不变，此片不会关闭整行。03D角色/morph语义不扩充、Native仍拒softBodies。

最小支持域：显式 vertexParticles 可含接缝重复映射或软体内部未显示粒子，必须覆盖所有渲染顶点且索引有效；目标 geometry 只能被该 instance 使用，禁止 LOD、既有 pose/deformation、tangent/normal-map 内容（没有动态 tangent 真值）。第一 profile 只接 translation-only instance；复用现有 affine inverse 将 world solver 输出回本地，再复用原面积加权 normal 生成；保留 UV/颜色/拓扑/材质。revision 由当前 packet 几何版本递增，不用 solver tick，回放不会倒退 renderer revision。无变化原 packet 原样返回，调用方继续持有唯一 packet，不引另一套场景或播放状态。

性能边界：第一片证明小网格真实资源消费；全包入口重传所改 mesh 的顶点/索引、重新算正常/bounds并重置 motionHistory，大规模连续帧、TAA/运动矢量与原位动态 buffer 优化尚待后继，不命名“高频生产完成”。

### 顶点流 CPU 草稿结果

`vertex-stream/manifest-frozen.json` 新3项：projection叶85行、测试112行、index导出增量；所有正式源未改。root已按第一片manifest提升static碰撞6叶并复跑正式34/34，完整SDK typecheck由root继续，不能将本片CPU与其GPU混计。

新流5/5 CPU、独立源码/测试 tsc退出0。消费真实现有session和正式PacketBuffers/MeshBuffers，fake device只承接GPUBuffer编排：实际solver xyz→本地xyz/面积加权normal→真实上传40B顶点流逐字一致；UV/索引/材质不变，实例上传复用；相同输出原packet返回且无新write。solver restore后renderer revision仍递增。真实upload失败保留旧visibilityRevision，同candidate重试通过。20 solver/resource循环owned buffer始终4、全部释放恰一次。

第一绑定profile严格 **translation-only**，旋转/非均匀/负scale拒绝；不扩复杂网格/LOD/tangent/既有deformation/共享geometry。这里证明CPU端实际资源消费，尚未接发布查看器帧循环或用GPU画面核对。每次changed geometry重建mesh+indices并重置motionHistory；不命名高频流完成。F6整行保持开放。

## PBR 帧循环小样现状核查

1. 关键词/工作树：已有 standalone-pbr-app、iC17ParticleFlowProduction 与正式软体 projection/session；本片只新增 example 和 ignored fixture，保留其他并行修改。
2. 合同：RenderPacket 是唯一 geometry revision 载体，RenderView/FrameMetrics 已有；不增加物理时钟、场景协议或产品 UI。显式绑定仍只接 translation-only 目标。
3. 依赖：现有 WebGPU、esbuild、Playwright；复用 PbrRenderer、FrameCaptureSession、sphereMesh 与 CSS 令牌，没有新增运行依赖。
4. 消费：真实 setPacket 更新 mesh；updateInstances 不上传几何，不能用来接软体。宿主每固定 tick 发布，诊断只在 tick0/240 render/readback；公开例提供逐帧 publish+render。
5. 测试/证据：34 CPU 与新流5 CPU已由主线验证；本片只补发布失败/渲染失败的 packet 所有权测试、24实际帧准入。fake renderer 单测不计 GPU。
6. 规格：原风旗/固定球盒输入、5%门不变；两 fresh×两 collider×enabled/contact-disabled/stream-disabled×两 checkpoint。本片证明真实渲染消费与释放，未完成 GPU 并行、持续高频、Native 或整项 F6。

发布顺序：projection→成功 setPacket→立即更新调用方 packet→render。render 失败也保留已经发布的新 packet；setPacket 失败保留旧 packet 并允许重试。actual captures 使用正式 HDR/present 附件，不引新 shader。SDK resourceCount/estimatedBytes 的释放不命名驱动 VRAM/总线测量。GPU、两轮截图复验和收据由主线执行。

## 21:02 实际 PBR 消费验收

公开例 `packages/deep-engine/examples/soft-body-pbr-frame-loop.ts` 已提升，正式 examples 类型检查通过。root 实跑 `pbr-frame-loop/run-2026-10-01T12-59-54.453Z`：两次独立硬件 Chrome、球/盒各三种模式、tick0/240，共 **24帧、116检查全部通过**。每个开启发布的 case 实际完成240次几何更新，revision=240；禁用流保持revision=0。solver binary64→实际 geometry binary32 逐字一致，两fresh全部顶点/solver/HDR/present附件相同；启用变形与禁用接触产生可见附件差异，禁用流前后附件不变。GPU validation错误为0，两次销毁后SDK资源计数及估算字节均为0。

root 独立复核 **460消费源SHA无变化**，收据 `test-output/jc-i-20261001-f6-gpu-root-verified.json`。已查看fresh0球与fresh1盒实际截图，布料和障碍可见、相机没有裁掉主体；该小样不是完整产品视觉评分。原CPU5%拉伸/体积门不变。F6整行仍开放：Native软体、GPU求解、动态耦合与大网格持续帧性能未验。

原冻结manifest保留，运行夹具两叶修订另记根收据：Windows绝对路径dynamic import改为既有createRequire；各独立case先发布空包，避免把同一geometry id的revision从240倒退到0。首次两帧失败保留。首次完整24帧的顶点、发布、fresh与释放通过，但HDR附件全零：fixture选择了直接display分支，未写HDR目标。改用既有spatialAA路径后，真实HDR与present目标可观测并通过全部原负控；旧失败24帧保留，不计成功证据。未修改生产守卫或物理参数。

## 原位顶点 publication 后继切片

资源基线必须在构造 opt-in 时捕获。默认 mesh 不复制；构造后作者原位修改 vertices/indices/UV，首次 stage 仍与实际上传基线比较；返回 lease 的可变数组不替代内部真值。原错误稿的5个精确负例失败保留，修订稿9项资源CPU回归通过。

8叶 publication 已经 root 按冻结 SHA 提升：显式单 geometry/单 instance、固定无纹理材质/transform/拓扑/UV/颜色，无 LOD/pose/tangent/deformation；默认关闭。沿实际 PbrRenderer.setPacket→PacketBuffers 原事务写非当前顶点槽，提交同时更新 source/bounds/batch 元数据/visibility revision，按 mesh identity 回收。空包 clear 后可重新建立基线。新增5项 publication CPU通过，验证20求解器投影更新、20生命周期、失败与取消重试、作者可变别名、默认替换路径。

root 正式完整 SDK typecheck（src/lab/examples）与 build 均 exit0，日志 `jc-i-20261001-f6-vertex-publication-formal-typecheck.log` / `…-build.log`。scratch 编译器宿主的3个 Node 模块解析报错保留为历史环境限制，不能计为正式默认全量失败或 SDF 回归。root 按冻结 SHA 提升3测试叶＋1 Utils，正式3文件 **14/14 exit0**，日志 `jc-i-20261001-f6-vertex-publication-formal-tests.log`。8源码＋4测试共12叶冻结，公开例文档已给单几何 opt-in 最短用法。原24帧证据不变；本原位 profile 实际 GPU与持续性能由root单独验收，尚不登记通过。未补 previous-vertex TAA 运动史；F6整项仍开放。

## 22:12 原位资源实际消费

root 实跑 `test-output/f6-vertex-stream-gpu-20261001/run-2026-10-01T14-12-36.091Z`，两fresh replacement/stream 同一cloth单geometry profile、tick0/240，共 **8帧、72检查 passed**。240次更新后 stock 创建241顶点＋241索引buffer，stream为2顶点＋1索引buffer；stream更新期 indexWrites=0。原solver/geometry数据与完整HDR/present附件在两模式和两fresh逐字一致，最终SDK资源计数0。这里证明真实原位资源发布，不新增物理输入/容差，原24帧接触证据继续保留。

root 核对 v1/v2 两fresh共四份PNG，SHA均为同一 `92b837…609191`，原截图文件正确；预览工具显示异常不计为实际渲染失败。v2保留双RAF的保守捕获等待，原8帧passed记录保留。该资源夹具不作完整产品视觉评分；持续帧FPS/大网格性能、previous-vertex TAA、Native软体仍未完成，F6整行保持开放。

