# C8 Native UNLIT跳过照明

Native UNLIT片元跳过CSM/RT可见性、BRDF、DFG、本地灯和IBL计算，保留作者颜色、coverage、法线附件、雾与曝光。

## 现状核查

1. 全仓src/assets/tests及未跟踪文件已查：ordinary/RT均先完整计算照明，再用bit64选择base；Web和Native作者ABI已长期支持UNLIT。geometryrough刚接正式消费，不重建材质/灯平台。
2. 类型：ShadingModel::Unlit、bit64、MASK bit2、BLEND bit4、fog off bit32、premultiplied bit128及normal MRT已有。基色纹理RGB乘材质base、alpha乘基色纹理alpha、MASK discard、材质normal/rough观测均保留。
3. 依赖：既有wgpu/pollster/serde_json/readback足够，不新增库或benchmark设施。
4. 消费：scene_pack编码bit64，普通shade_native_mesh与RT fragment各有完整照明块。曝光来自authored-light mode而非lighting结果；雾在UNLIT颜色选择之后；不能随照明块挪入guard。
5. 测试：surface_flags_draw已有UNLIT fullHDR金样/金属rough/emission无影响，production_transparency_draw已有straight/premultiplied/zero/double-sided真像素；j3_author_fog已以UNLIT做完整生产HDR控制/两相机85点。新叶只补照明极端变化下MASK/BLEND coverage和normal MRT保留，不复制这些矩阵。
6. 规格：读B6 actual-frame-followup、Native geometry/local规格及本轮锁。生产和具名Cargo/GPU由root执行；性能交付是实际生产分支跳过工作，不在无计时证据时填性能比例。

**已有（不重建）**：UNLIT合同、所有coverage/texture/fog/exposure、正式GPU绘制和测试。**真实缺口**：UNLIT仍执行全部照明后丢弃结果；现RT编译门None返回没有明确unsupported收据。

## 最小接线与风险

base、alpha/MASK discard、geometryrough和mapped normal留在照明guard外。初始化surface_color=base；仅`!flag(material.w,64u)`时计算原照明块与emission并赋surface_color，原lit乘法/加法顺序逐字保留。authored_light/exposure和雾仍guard外。没有额外return，避免旁路coverage与normal MRT。

implicit textureSample和canonical dpdx/dpdy留在guard外；guard内已有DFG/IBL用textureSampleLevel、CSM用textureSampleCompareLevel，未新增隐式导数/uniformity前提。bit64分支随实例材质；不将mapped normal当geometry derivative输入。不改变castShadow，UNLIT对象是否投射阴影仍由作者控制。

新增最小正式测试叶复用FrameObservation/现已验证geometry fixture和正常读回；opaque normal MRT颜色/rough、MASK cutoff边界、BLEND alpha不因主光/local/IBL变化改变。固定曝光1/雾关的两种照明配置要求全HDR逐字相同；雾/曝光应继续由既有B6/生产控制验证。MASK接受/拒绝和非空覆盖须实际有正例，不能全黑空跑过门。source控制同时要求ordinary/RT照明工作位于bit64 guard内，guard外存在原geometry/normal/fog/exposure和output alpha。

RT具名`rt_fragment_pipeline_family_compiles_on_ray_query_device`执行时：helper将adapter请求失败记录为`ray_query_supported=unknown reason=adapter_request_failed`，实际adapter缺少feature记录为`ray_query_supported=false reason=feature_missing`并保存info/features；测试None分支仅记录`ray_query_pipeline_executed=false reason=adapter_or_feature_unavailable scope=not_executed`，不笼统断言硬件unsupported。支持设备完成6variants且validation scope干净之后才记录`ray_query_supported=true pipeline_variants=6 validation_scope_passed=true`。None分支不认证RT管线，更不认证完整RT实帧。保留其它RT消费者已有fallback，不扩设备请求平台。

六步与风险预登记完成；实际结果见下。

## 实帧叶预登记

复用C8 geometry的合法smooth-normal平面与Gram-Schmidt切线，固定axis相机/128²/曝光1/雾关。6case为opaque、mapped、MASK accept/reject、BLEND、lit-control；两fresh×2照明=24帧。base纹理constantRGBA(128,192,224,128)，MASK cutoff .5接受、.51拒绝，BLEND覆盖使用真实纹理alpha。原material base(.25,.35,.45)/metal.4/rough.08，emission(16,8,4)作为UNLIT应忽略的实参。

照明0为主光RGB0/local无/IBL0/shadow关；stress为主光(256,128,64)、point(64,32,16)/position(0,0,4)/range20/decay2、IBL1/shadow开。实际FrameObservation保存灯行，UNLIT完整HDR必须逐字相同，lit-control至少1000真实像素改变，证明照明配置有效。内部[24,104)²统计至少1000点RGB任意通道>.05；MASK reject必须0覆盖。opaque/mapped实际normal MRT在两照明下逐字相同；BLEND没有生产normal MRT，不冒称该附件观测。

CPU源门要求ordinary/RT的CSM或RT可见性、BRDF、DFG、local与环境采样调用全部在bit64 guard内；geometryrough、mapped normal、authored exposure、雾和alpha在guard外。该门锁定省去的生产工作，不使用CPU计算替代实际HDR。旧成功evidence先删除，全fresh矩阵完成才写新收据，记录真实变更packet、正式组合shader和完整frame行身份。不会据此填写未计时性能提升比例。

## 实际结果

root执行CPU源结构门1项与正式shader解析9项通过。两个fresh device的24帧通过：UNLIT完整HDR、coverage与适用的normal MRT在零照明/stress照明下相同，lit正控制发生实际变化。结果见 `test-output/interrupted-0930/c8-native-unlit-lighting-skip/evidence.json`，具名GPU日志 `c8-native-unlit-gpu.log`。作者雾现有正式叶在本刀source上重新执行16帧通过，日志 `c8-native-unlit-author-fog.log`，确认guard外雾仍消费。

RTX 4060 Laptop / Vulkan实际支持EXPERIMENTAL_RAY_QUERY，6个RT管线变体完成创建且validation scope通过，日志 `c8-native-rt-pipeline.log`。该结果认证管线编译，不包含RT实帧矩阵。UNLIT照明计算已跳过，帧时收益尚未计量；完整C8继续后继。
