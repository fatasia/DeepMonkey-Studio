# I-C16 不透明生产PBR路径材质

在现有CPU路径积分循环内加入无纹理不透明PBR材质，复用生产IOR/F0、r185 DFG和C8直接多散射参数。源码先置于 ignored `test-output/i-c16-dielectric-20261001/`，正式I23源冻结期间不提升。

## 现状核查

1. 全仓packages/apps源及未跟踪文件核查：pathTraceCpuBsdf仅Lambert与GGX导体两model；adapter明确拒绝dielectric与mixed metallic。没有联合BSDF消费，现有多实例/TLAS/相机/生产session保留。
2. 读contracts SceneMaterialState、PbrMaterial、PathTraceCpuMaterial、RuntimeSceneCamera：已有metallic0..1/roughness/IOR与正式包，不另设场景/材质协议；CPU model需增加生产PBR，原显式参考model保留。
3. package已有TS/Vitest/esbuild，Native固定wgpu/serde；复用materialDielectric和directDfgLut185，不增依赖，不运行Cargo/GPU。
4. samplePathTraceCpuBsdf由唯一pathTraceCpuTransport调用；BLAS核与RenderPacket核共用该循环。adapter由packetScene快照消费；PathTraceCpuRender/既有Node例子承接积累、取消、统计和HDR，不重建积分器。
5. 已读PT kernel/render/adapter/CLI测和CPU证据。现导体用C3 correlatedSmith但分母floor1e−9、pow5 Fresnel；生产stock用floor1e−6与SG Fresnel，C8另有多散射。旧IOR1 Lambert解析域不代表全部生产stock。
6. 已读remaining I-C16、恢复ledger、交接与reference-integrator/packet-adapter/offline-cli规格。完整材质、MIS、纹理/法线及产品UI仍未覆盖；本片不关闭整项。

**已有（不重建）**：相机/TLAS/BLAS、transport/RR/RNG、Lambert与GGX NDF采样、materialDielectric F0、r185精确half表/双线性CPU采样、session/HDR/CLI。

**真实缺口**：生产stock diffuse+single GGX+C8 multiple的CPU联合求值、对该完整响应无偏mixture PDF、标准dielectric/mixed material适配及独立积分/重放/收敛证据。

## 数学范围与支持域

stock diffuse=(1−metal)*base/π；Fresnel=SG exp2；IOR1.5精确F0=.04，其他IOR复用dielectricF0。roughness夹取[.045,1]，flat世界法线无导数粗糙项；GGX distribution与correlated Smith floor1e−6逐公式对应生产WGSL。C8 multiple复用r185 DFG(view nv夹取.001,light nl)与现有共享WGSL能量式，累加multiple×nl。

联合采样包含cosine与GGX NDF，任何方向都用总响应除总PDF；PDF使用真实未裁截NDF密度，不能把BRDF数值floor变为抽样概率。GGX反射落到下半球为零样本且不重采样；保留其离散概率质量。全金属仍需cosine分支覆盖宽C8 multiple瓣，不能只按spec PDF消费multiple。保留显式Lambert/GGX参考model及旧seed行为，新profile不承诺旧adapter样本恒等。

可支持标准OPAQUE、doubleSided=true、flat、static实例，无纹理/顶点色/扩展/层/透射；metal0..1、IOR≥1、rough0..1；发光沿原链。adapter的profile显式标识生产single+multiple响应。stock diffuse未减Fresnel，白炉可能>1：证据如实报告数值，不改生产公式或放宽验收来宣称全域能量守恒。

## 最小草稿锁与验收

候选生产改动仅pathTraceCpuTypes、CpuBsdf、CpuKernel验证和RenderPacketMaterial；新增一个≤300行生产PBR求值/采样叶。复用原采样辅助提取，仅增加mixture分支；不改transport/RR/session/TLAS/index/CLI。旧adapter测试中IOR1解析预期需改为独立完整生产积分证据；旧显式Lambert/conductor核测保持。

CPU先记录dist adapter拒绝dielectric/mixed失败，再用隔离draft resolver跑原参考核/session及新数学/packet测试。核对生产WGSL source和Native CPU默认IOR直接核；独立闭式+精确half解码DFG oracle、normal-view数值积分、mixture PDF/零拒绝mass、metal0/.5/1与rough0/floor、IOR变化、固定seed/分批/收敛/取消/HDR。不启动GPU/Cargo，不提高容差。

## 草稿冻结与实际 CPU 结果

2026-10-01 15:27 冻结 ignored 草稿11文件；正式源未修改。`test-output/i-c16-dielectric-20261001/promotion-manifest.json` 保存每个正式源 beforeSHA、新文件空 beforeSHA、草稿 afterSHA 和行数。生产PBR新叶52行；最大提升叶137行。提升范围为上述5源、新数学/packet测、原adapter测及既有例子的fixture/test/说明，CLI消费主体、transport/session/TLAS/index均不变。

`before-public-builder.json` 记录当前实际dist公开工厂对默认IOR介质和metal=.5分别拒绝；草稿实际CPU 65/65、真实Node CLI消费6/6、969正式TS根文件以5草稿模块替换后typecheck零错。Node消费使用ignored source bundle/hook，正式SDK dist仍待主线build后无hook复验；`cpu-delivery-receipt.json` 清楚区分此边界。

独立证据：实际生产stock私有CPU函数与规范C8 WGSL body共60组合最大误差6.782768791069316e−16；独立half解码/四格DFG插值加法线视角闭式积分，metal0/.5/1×IOR1/1.5/2九组合65536样本最大误差约.001452，小于原.006门。alpha1 GGX分支下半球拒绝质量保留，总接受率匹配.75。rough0与.045逐样本恒等；16独立seed实际integrator RMSE由16spp的.061150下降到4096spp的.004873。

正式packet→TLAS kernel→async session→HDR实跑16384spp，mixed-metal独立期望RGB [.5450609106424684,.27005523499793294,.13747006084036667]，RGBE解码 [.5390625,.26953125,.13671875]，绝对误差过.007门。分批3+17+108与128逐值重放，异步取消释放驻留并拒绝旧generation导出。另有两真实静态实例共享BLAS的Node出图，noise=.007109375321509948；RGBE roundtrip max=.0025565624237060547；HDR SHA256 `159647ad1f3522d129a94e99f3384f2f98eaf523a3da44b822cff4dd8c3ba154`，文件在 `cli-real-output/result.hdr`。

旧测试更新依据：IOR1生产stock仍有SG掠射Fresnel和C8，不能再要求adapter四样本恒等Lambert；改为独立完整生产积分及实际HDR统计验证。原显式Lambert/conductor测试和seed保持。CLI解析full-metal参考增加独立C8积分，原Lambert RMSE .004与metal RMSE .03门均保持，spp1024改16384以满足新联合抽样方差。旧unsupported-dielectric用例改验证真正仍不支持的单面材质。stock白介质独立能量1.0125343624638836沿生产未衰减diffuse公式保留。

复验入口：deep-engine目录运行 `pnpm exec vitest run --config ../../test-output/i-c16-dielectric-20261001/vitest.config.mjs --reporter verbose`；root目录运行 `node test-output/i-c16-dielectric-20261001/typecheck-drafts.mjs`。CLI草稿命令见 `draft-cli-tests.txt`，提升并build后应运行未设置NODE_OPTIONS的 `node --test packages/deep-engine/examples/offline-path-trace.test.mjs`。不提升 `pathTraceOpaquePbrOracle.test.ts`、生成source oracle或hook。

I-C16整项保持开放：平滑法线、单面、纹理、alpha/扩展/分层、MIS、作者产品入口仍缺。作者入口和平滑法线另见 `i-c16-author-export-smooth-audit-20261001.md`。

## 主线提升状态

2026-10-01 root已按manifest逐项核对before/after SHA并提升全部11文件到正式树；原ignored manifest/staged继续冻结。正式SDK build及无hook CLI复验由root进行中，结果以主线新收据为准。下一smooth/frame切片独占另一个ignored目录，未改此批源码。

root随后确认正式SDK build及无hook CLI6/6、正式源码62/62、purity/source-size/runtime freshness/tsc全通过。前文draft-only证据保留历史原状，正式消费验证已由主线补齐。
