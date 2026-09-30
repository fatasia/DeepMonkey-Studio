# C8 Native 本地直射补能实际控制

复用正式FrameObservation与原constant-DFG差分，验证额外方向灯/point/spot消费canonical多散射。生产由root接线，本叶不修改渲染器。

## 现状核查

1. 全仓src/assets/tests及未跟踪文件：Native主光补能与correlated LUT已由root完成；native_mesh_v1.wgsl的local_direct_lighting末尾仍单散射。Web S9已真实两fresh收口，不复测。
2. 类型：RuntimeLocalLight/Native LocalLight既有kind1/2/3/4、radiance/range/decay/cone/shadow/IES。DirectionalLighting.apply把locals存在记为sunColor.w=3，主光关闭由sunColor.rgb=0表达；w不是强度。local count在lightingOptions.z。
3. 依赖：现有wgpu/pollster/serde_json/winit及半精度解码，无新增依赖。Native LUT保持32²×128预算，root独立f64 oracle另验证积分。
4. 消费：普通/RT fragment都调用同mesh-body local函数；frame_bindings共享canonical energy，主光helper已只NL guard。作者compileSceneLighting提取首directional为primary，point/spot-only primary RGB0，locals由真实序列传递。hemisphere独立continue。
5. 测试：原c8_direct_multiscattering.rs已有正式FrameObservation、同golden package/flat-normal manifest、独立f64 constant-DFG energy。已有renderer local_lighting_tests验证实际range/decay/cone/hemisphere；本刀不建第二pipeline。
6. 规格：读C8 S5/S9、Native direct/LUT规格与本轮锁。root拥有生产shader/登记/Cargo/GPU，当前仅新测试叶及原叶pub(super) helper开放。

**已有（不重建）**：作者灯序列、Native局部阴影/IES、canonical补能、单LUT、正式测试绘制链。**真实缺口**：local单散射没有使用同canonical能量，缺少primary RGB0/w3实际补能差分证据。

## 预注册控制

只取已有axis相机和两个golden-copper平面三角形稳定样本，normal=(0,0,1)、plane z=0，曝光1.0、IBL关闭。本地RGB(2.5,2.4,2.25)，额外directional沿原主光surface方向(-.6,-.3,sqrt(.55))。point/spot点位置(0,0,4)、range20/decay2，spot ray方向-z/innerCos.9/outerCos.5，完整cone内。实际pixel world由axis相机像素中心射线与plane z=0求交（f64，focal取现PlayerView f32值），不借GPU结果生成期望。

预登记历史：最初文档草案RGB(32,30,28)尚无测试叶/实测；写叶前改为原主光(2.5,2.4,2.25)，directional沿原主光方向，避免高HDR的half量化噪声主导此能量消费控制。变更发生在任何GPU运行之前，误差门仍.002；固定最终fixture不按实测结果再调整。

两fresh设备，每case各实际DFG零与constant(.5,.04)附件；差分独立f64 energy×NL×radiance×finite-range inverse-square attenuation，对应原canonical常数，误差≤.002。正向三灯样本每lane必须真实增加；zero/back/outside range/reversed cone/hemisphere控制样本必须逐值相同。zero/outside-range/reversed-cone/hemisphere另要求整HDR附件逐值相同；back只定义在登记的平面normal子集，其他曲面可合法被该方向照亮。总9cases×2DFG×2fresh=36正式HDR帧。额外directional direct方向为surface-to-light，spot direction为ray，不混用符号。

FrameObservation实际encode hook核对primary RGB0/w3、local count1、kind行、IBL0并保存真实frame灯行；正式生产shader源码/包/packet身份记证据。旧evidence在开始前删除，只有两完整fresh矩阵稳定且所有样本过门才生成成功收据。真实RT硬件、聚簇分配正确性、默认LUT跨端画质、Studio视觉与性能不在本门认证范围；现正式helper默认cluster buffer无有效header，本测试走已存在的Native uniform local列表消费。

本叶由C8线路完成CPU源码审核，实际Cargo/GPU由root运行，结果如下。

## root实际结果

root已执行 `cargo test --manifest-path packages/deep-engine-native/Cargo.toml --locked --test gpu_shader_material_draw c8_actual_local_direct_multiscattering -- --ignored --nocapture`，日志 `test-output/interrupted-0930/c8-native-local-energy-after.log`。两fresh设备、36正式HDR帧通过，独立f64差分最大误差 `.00006172440528463136`，预注册`.002`不变。证据 `test-output/interrupted-0930/c8-native-local-energy/evidence.json`。主光RGB0/mode3、真实local行、正贡献和所有zero/背光/range/cone/hemisphere控制通过。

root另执行真实白炉 `cargo test --manifest-path packages/deep-engine-native/Cargo.toml --locked --bin deep-engine-native white_furnace_gpu_tests:: -- --nocapture`，2测试通过，p99约.049%，日志 `test-output/interrupted-0930/c8-native-dfg-furnace-actual.log`。先前误用`--ignored`筛出0测试的日志保留但不算PASS。既有生产控制过滤器 `production_ --ignored --nocapture` 实际2测试通过，11.52s，日志 `test-output/interrupted-0930/c8-native-local-production-controls.log`。

GPU由root确认释放给I。此叶仅交付本地能量消费控制，默认LUT/Web原Three全链HDR画质、RT实际硬件、cluster选择和完整Studio视觉仍按上列范围保留。原灯数量/方向/衰减/cone/IES/局部阴影/hemisphere语义与宿主ABI保持。
