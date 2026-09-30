# C8 Native 主光共享多重散射

将已在Web正式主光消费的直射多重散射核接入Native栅格和RT主光，复用既有DFG资源和绑定。

## 现状核查

1. 全packages/apps及未跟踪检索：Web-S5已消费canonical brdfDirectMultiscattering，Native仍只有single-scattering；未跟踪粒子/脚本草稿无关，不覆盖。
2. 契约：Native FrameUniform/sunColor.w是作者模式，Web该lane是强度，不能复制宿主判断；DFG binding5、environment_sampler及RT同frame ABI已存在。
3. 依赖：Cargo现wgpu/naga/bytemuck/pollster/serde和原测试读回足够，不新库。
4. 消费方：frame_bindings普通/RT拼接，native_mesh shade与RT fragment两消费；现local direct灯另有循环。本刀只主光，复用view DFG供IBL，无新buffer/texture/sampler。
5. 测试：lighting_math_wgsl已有checksum/组合parse，实际shader_material_renderer+FrameObservation可用于正式HDR。J3 fresh法线阴影2559cd9b已验，不改其fixture/门；新constant-DFG控制仅独立原场景测试。
6. 规格：已读C8-S5/S6/S7/S8与J3 shadow/current ledger。S8导数残差仍unexplained，不调生产导数/原Three曝光/严格HDR阈值。

已有（不重建）：canonical共享核、Native DFG纹理/sampler、正式mesh/RT编译链、CPU/GPU测试宿主、真实HDR读回。

真实缺口：Native拼接共享多重散射文件、主光按Native实际语义消费、同view DFG复用、双变体与正式HDR量化证据。

## 预登记

独立测试沿原package/camera/mask，通过真实production mesh绘制，用constant DFG=[.5,.04]与zero-DFG控制消掉single-scattering。独立CPU公式给出增量，所有原85点、两fresh devices；背光与零能量控制保持0。绝对HDR增量门0.002沿既有half阈值，执行前冻结；不按结果筛点或拟合门。默认资源/ABI不增加，IBL关不等于主光DFG资源无效。

Native内置DFG仍32²×128、Web128²×256，Native旧Smith-LUT核与Web相关Smith不一致，这是真实后继。本刀不以constant DFG证明默认LUT/整套材质等价。聚簇/local灯另项，完整C8未关闭。

## 实测与收口

主线程共享checksum/组合解析9测、原白炉CPU8测通过。新具名实际测试两fresh硬件设备、24正式HDR帧，两个相机全85点×lit/back/off×两devices共510样本；同输入结果跨两devices逐值相等。constant-DFG增量最大误差0.00042655684471536864，小于预登记0.002，lit每通道实际上升，背光/零太阳差值0。控制调用同production mesh/pass/正式shader，只修改既有DFG纹理内容；无替代shader。实际证据 `test-output/interrupted-0930/c8-native-direct-energy/evidence.json`，日志 `c8-native-energy-gpu.log`。

原production材质/LOD/CSM/透明控制两实机测试通过（11.56s）；实际白炉球/墙两测试通过（1.46s），geometry p99误差0.049%、色偏0。IBL同view DFG复用，关闭主光不采light DFG；没有新增绑定/资源/帧字段。RT factory与片元均消费同核，尚未将此源码/解析覆盖写成实际RT硬件认证。

Native builtin LUT profile差异与Web local/cluster补能另推进。C8严格HDR/导数残差仍未关，原Three基线、曝光与质量门保持。Native源码变更后的WASM/freshness由主线程同步。
