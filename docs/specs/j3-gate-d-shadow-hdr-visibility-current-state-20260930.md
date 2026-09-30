# J3 Gate D：真实 HDR 阴影可见度

同一RuntimePackage、同一相机和原85个预登记像素，以正式HDR附件与无遮挡控制计算阴影可见度。双端共同4级联的170个实际读回样本已通过独立量化区间比较；统一默认fresh命令已由主线程通过。

## 现状核查

1. **源码/未跟踪。** 已检查状态和双方CSM、ShadowMap、FrameObservation、PBR/Native片元；法线首刀已提交32d65519。本刀只增加独立测试/runner/比较器，正式阴影绘制与片元保持。
2. **契约。** 已有DirectionalLighting.shadows、Web receiveShadow、双端CSM options和原RuntimePackage。Native正式cascade数合同为2..4，Web支持1；共同严格矩阵仅4，Native2/Web1各自诊断。Native uniform21vec4/84floats，Web39vec4/156floats，各自解码。
3. **依赖。** 原Node fs/child_process/crypto/assert/node:test、serde_json、bytemuck、现HDR半精度decode均可复用，无新增依赖。
4. **消费方。** 真实mesh pass已绘制shadow atlas并用正式片元消费；sampling_uniform已有COPY_SRC。原Snapshot.depths保留实际shadow map，新的观察参数仅向现ShadowMap工厂传合法options。不增加第三MRT、替代shader或renderer。
5. **测试/证据。** 已有normal首刀24帧Web HDR/map/uniform、Native具名shader draw支撑和85个冻结mask。复核真实Web csm1/4的PCF边界及HDR/control比值；半精度的单独预算已CPU验证，不把helper固定世界点采样误差归为half。
6. **规格。** 已读J3 normal-shadow、geometry/HDR规格与恢复台账。允许实际depth-fit矩阵差异，严格判据来自真实HDR可见度；完整85点不按实测相似度删点，默认runner不得把历史比较宣称fresh。

**已有（不重建）：** 同包、正式前向HDR、实际shadow maps、CSM options、真uniform、光照/受影开关、原camera与85mask、现Web producer。

**真实缺口（本刀已补）：** 独立Native HDR/control读回、各端合法cascade矩阵、GPU uniform实际ABI解码、由binary16物理量化推导的visibility比较器。完整材质与复杂shadow家族仍待后续。

## 实现与门

Native新 `j3_shadow_visibility.rs` 1次真实具名测试执行16帧：2/4cascade×两camera×baseline shadows=true/同packet同frame shadows=false×两round。原copper triangle没有emission；关闭IBL、local lights、fog，作者太阳与曝光一致，控制RGB均为正。读完整真实84float uniform、HDR样本和实际shadow map哈希/nonclear计数，不新建片元。

Web复用normal首刀24帧的baseline与triangle receiver-disabled控制；canonical helper采样仅用于诊断。双方4cascade profile固定map2048、far40、lambda.7、padding10、blend0、bias.00075。Native2/Web1保持各端真实诊断，不作同语义对拍。

`j3ShadowVisibilityIntervals.mjs` 由binary16相邻值中点构造HDR真值区间，处理0/subnormal/2幂处不对称ULP；以B/C计算每RGB可见度区间并取三通道交集，计单次f32 multiply预算2^-23。双方区间必须相交；不拟合epsilon，不允许非half、negative/zero control或不一致RGB比例。

比较器验证来源、所有固定mask、同camera VP、实际count/map/bias/splits/blend、Native作者光照、control map/uniform未变、重复HDR与uniform稳定。允许不同depth-fit矩阵并保存各自原始uniform。失败也记录所有具体像素差值，不缩减mask或放宽原HDR门。

## 实际结果

Root首次Native尝试cascade1被正式2..4合同拒绝，随后使用合法2/4执行具名测试PASS（16帧、39.24s）。此前Web24实际帧PASS。

本次CPU比较双方共同4级联：axis45点、oblique40点，各两round，170samples全部visibility区间相交，0 differences、maxVisibilityIntervalGap=0，重复稳定。完整记录在 `test-output/interrupted-0930/shadow-visibility/comparison.json`。原32个TLAS遮挡点与全部PCF边界均保留。各端depth-fit矩阵独立读回，未替换成一个预制矩阵。

两腿为独立真实命令、同device两round draw。`--compare`证据currentRun=false，明确既有Web receipt与新Native receipt；它只做CPU比较。`node scripts/j3-shadow-visibility-parity.mjs`默认清旧Native后依次执行具名Native normal/shadow，再调用原Web producer的--web-only；不重复Native normal测试，只在全部比较与完整生产/observer source身份稳定后发布currentRun=true。

## 验证与范围

interval helper5与比较器5 CPU测试共10PASS，node syntax和rustfmt PASS。实际Native/Web与比较结果如上；新统一默认runner已通过（法线与阴影同批fresh）。截图沿用原Web深色1920×1080双轮，数值目标128²不变，不重跑无变化视觉。

完成的是原平三角纯直射共同4级联shadow子集。normal-map、smooth/透明/MASK/deformation/local shadow/作者soft-shadow、driver VRAM与GPU帧时、完整Gate D仍在剩余范围。只验证实际附件语义，不计产品画质评分。

## 主线程统一fresh与J5接入

主线程扩展现runner，两个具名Native测试各一次，原Web24帧一次，同时调用原法线与本次阴影比较器。默认实机passed/stable/currentRun=true，170阴影样本零区间差；法线最大world角0.4071987039234767°，两端各对独立oracle均在预登记量化界内。完整生产与observer前后SHA相同，见shadow-visibility/evidence.json与normal-shadow-suite-fresh.log。

J5新增normal-shadow-production双腿，共用该默认fresh命令，退出失败传播到两腿；14对28腿计划与严格命令去重/失败传播共31个相关CPU测试通过。本次执行的是新增实机suite；此前窗口全量失败证据保留，未将这次专项结果写成新28腿全量通过。
