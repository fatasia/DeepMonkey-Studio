# I-C16 局部坐标相机与平滑法线草稿

在已有CPU路径会话和静态TLAS适配中支持合法authored normals，以及正式相机的scene-local坐标框架。独占 ignored `test-output/i-c16-smooth-author-20261001/`；标准PBR前批11文件及正式源保持不变。

## 现状核查

复用已完成六步核查 `i-c16-author-export-smooth-audit-20261001.md`；本片再次读camera/coordinates、sceneLocalCoordinates、compileSceneRenderPacket、compileSceneCamera和surface/transport消费确认语义。已有软件closest-hit距离、snapshot-owned preparedBLAS、packet编译和async session不重建。真实缺口为PT局部重心插值、geometric/shading normal分离及frame消费；既有hit重心恒0与16B ABI不改。

## 合同与最小锁

相机有coordinateFrame时，position/target与同资源packet的实例变换均已在scene-local空间。validator验证profile、origin grid与往返精度；积分保留local值，输出kernel保留frame快照供world归属，不再减origin或删metadata。section clipping仍明确拒绝。作者CPU端到端使用实际localizeSceneCoordinates→compileSceneRenderPacket和compileSceneCamera，保留precision/profile负例。

triangle preparation缓存local edges、Gram、三顶点normal和geometric normal；命中hit.t重建local点，求Gram重心并插值，inverse-transpose变换。flat normal保留旧cache/逐值行为。几何法线定向前后面与epsilon偏移；着色法线定向跟随几何，采样方向若落到几何背半球则零贡献且不重抽样。着色法线背向观察方向时贡献为零。零/非单位/局部或变换后反向normal明确拒绝，不能静默矫正成flat。

生产对照细化：Web pbrShader.ts:97及Native native_mesh_v1.wgsl:314均先normalize(inverseTranspose*cornerNormal)，再插值；草稿缓存每个命中triangle的三个world单位normal，按local重心插值后再次normalize。非均匀缩放反例中，先local插值再变换的错误方案与正确结果差距>.06。local法线在工厂前验证，transform后的同半球验证按visited instance/triangle惰性进行；失败抛错并经现有session释放积累，最终导出拒绝。profile改为 `production-opaque-two-sided-pbr-single-and-multiple`，不继续误称flat-only。

本核只沿相机进行radiance transport；着色normal用于BSDF及cosine，反射半球由geometric normal约束。这与[PBRT BSDF几何半球说明](https://pbr-book.org/3ed-2018/Materials/BSDFs)一致；[PBRT法线的非对称输运说明](https://www.pbr-book.org/3ed-2018/Light_Transport_III_Bidirectional_Methods/The_Path-Space_Measurement_Equation)中radiance correction为1，adjoint修正用于importance模式。本片不加入双向输运或法线重归一能量补偿。

候选正式锁：pathTraceRenderPacketScene、pathTraceRenderPacketKernel、pathTraceCpuTransport，以及新PT局部normal叶与聚焦测试（每新叶≤300行）。不改生产光照、TLAS/BLAS构建、RNG/RR、session/CLI、作者UI或ABI；PBR数学消费前批冻结实现。

## 独立验证设计

先解析顶点/边/内部重心与normal、rotation/non-uniform/shear/mirror、两个共享几何实例、snapshot输入后改；flat与旧路径逐样本恒等。Lambert倾斜白炉独立积分为rho*(1+dot(ns,ng))/2；采样严格保留被几何半球拒绝质量。强倾斜PBR用独立sphere数值积分对照现有stock+C8 source oracle，不放容差，不宣称生产stock全域energy≤1。仅背面亮环境应严格零贡献；双面背视与正视成镜像响应，epsilon必须朝几何出射侧避免自交。实际作者compiled sphere/GLB合法normal消费、取消/HDR、single-side和texture拒绝另验。

## 实际草稿证据与提升范围

CPU11文件98/98，970正式源根文件以5草稿替换typecheck零错。正式可提升回归88测，其余为5个实际作者compiler消费和5个独立source oracle，后者留ignored。Lambert0/30/60/85°白炉最大误差.001929<.005；强倾角背面亮环境65536个sample全部0；双面约84.3°结果front=.441187/back=.439050，独立期望.439801。真实epsilon沿geometric，无着色切向偏移；ns背向view零贡献已测。

根路审查发现dot容差flat优化会抹掉微小authored倾角；现仅三个corner逐分量完全等于几何normal时复用flat缓存。新增两个完整packet实际hit回归：全部角normal为normalize([.001,0,1])及各角小幅不同normal，独立Float32存储/单位化/解析重心oracle逐分量14位对照。保留旧参考seed恒等，不以角度容差删除真实normal。

stock+C8 source在几何半球512×512角度数值积分，对60°期望RGB [.4486019366413083,.2232196271181554,.1144123559663043]，65536sample实值 [.4453639298307237,.2216070403550239,.11358523718479033]；85°期望 [.39771751862719923,.20134113288874425,.10480677554090664]，实值 [.3927279731717749,.19881949220048709,.10349657697289882]，最大误差.004990<.006。两个值已固化为可提升独立golden，生成source oracle不入src。

spy实际buildTracedScene：两个共享实例建1个BLAS，4096个smooth rays后仍1次。实际Apps编译带旋转/非均匀缩放sphere，frame origin[1e9,-2e9,3e9]，完整512逐pixel样本与同local无frame相机恒等；source snapshot未改。async4096spp导出真实2×2 HDR，noise=.01599913810926，SHA `d20fc1496654c79e493b4722559a482c8b7e6e102b7e20ed55e23a379c92fbef`，位于ignored目录 `author-smooth.hdr`。真实BoxTextured.glb经sharp及实际compiler保留纹理，PT明确拒绝；实际作者single-sided拒绝；非法frame/profile/roundtrip、section、取消及驻留0均通过。

冻结manifest共11文件：5生产叶（四已有+新normal叶）、3新聚焦测、2既有adapter/packet profile迁移测、既有CLI说明；新叶最大73行，整批最大140行。原PBR草稿不改。命令在engine目录：`pnpm exec vitest run --config ../../test-output/i-c16-smooth-author-20261001/vitest-regression.config.mjs --reporter verbose`；root目录：`node test-output/i-c16-smooth-author-20261001/typecheck-drafts.mjs`。根路已审 exact-flat 回归并按新 manifest 原子核对提升全部11文件；正式88测、SDK build/CLI复验由根路继续。此子路无GPU/Cargo/commit。
