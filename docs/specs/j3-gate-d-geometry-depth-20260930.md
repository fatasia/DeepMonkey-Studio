# J3 Gate D 几何与主深度首刀

日期：2026-09-30。目标是同RenderPacket、同相机的生产几何覆盖及主深度对拍；HDR仅作为有效画面证据，材质色差不在本刀等价范围。

## 现状核查

| 六步 | 已有（不重建） | 真实缺口 |
|---|---|---|
| 源码/未跟踪 | 已检索packages/apps以及当前git status。Web PbrRenderer/RenderTargets/cameraMath、Native frame_data_with_camera/PlayerView/ForwardTargets/mesh_pass、真实shader_material_renderer已有；J3-E驻留observer刚完成实测。 | 现成Native helper固定256²、frame_data(yaw=0)，Web恢复fixture使用128²及另一相机；两幅图不能当同相机对拍。 |
| 契约 | RenderPacket/RenderView/PlayerView、正式runtime包解析及RenderPacket物化器已有。两端透视都是标准Z的0..1。 | Gate D几何层需要固定viewport/eye/target/up/FOV/near/far及源payload hash；不能把两套FrameUniform字节要求成同ABI。 |
| 依赖 | wgpu30/pollster/serde_json、Chrome/Playwright/esbuild、现有half decoder和GPU staging/readback均在用。 | 无新依赖，无需替代renderer。 |
| 消费 | Native Renderer/GpuCulling/CSM真实消费frame_data_with_camera；shader_material_renderer消费生产GpuScene、LOD、pipeline及mesh_pass。Web PbrRenderer用updatePbrFrameUniforms将lookAt/perspective结果真正上传。 | 当前Native snapshot.depths是四层阴影深度，不能冒充主视角深度。 |
| 测试/证据 | Native gpu_lod_views_tests覆盖相机projection→depth/LOD/CSM；TS pbrCameraProjection测试覆盖perspective。J3-D输出门及J3-E实际包upload/HDR/CSM读回已有。 | 尚无同相机的实际主深度跨端门；Native主深度为4xMSAA，Web为1x，边界采样存在合法差异。 |
| 规格 | 已读J3总门、Gate D output首刀、Gate E device首刀、handoff/恢复台账及J3-D-full剩余项。 | 本刀只补几何覆盖/主深度，HDR材质、阴影/法线、完整后处理仍后续。 |

## 最小可安全实施范围

复用现有`deep-engine-native/tests/fixtures/runtime-package-v1.json`：四个静态实例、两种不透明材质，包含缩放/平移的立方体及正常/镜像三角形；无作者ShaderPackage、无LOD切换及透明语义。两端正式解析同一原packet，不改实例或材质。新manifest记录包hash、实际payload SHA-256和两组固定Y-up透视相机（轴向及斜向），每组重复两次。

Native只给既有生产帧helper增加test-only可选相机/尺寸及编码后观察接缝；原render/render_checked/render_reported/recovery调用默认参数及行为保持原样。使用frame_data_with_camera，不手拼矩阵。主深度从真实ForwardTargets.depth_view读出4个MSAA样本；不新绘制一套几何、不修改生产MSAA档。Web实际PbrRenderer上传同包、validateFrame，再读真实hdrTexture及depthTexture，关闭TAA和影响覆盖的地面/网格/后处理。

主深度读回只是compute采样观察：Native texture_depth_multisampled_2d逐样本，Web texture_depth_2d。已有生产HiZ亦消费同Native主深度，但它只输出min；本观察保留全部4样本用于明确MSAA差异。双方先证明非空有效几何，再按预注册合同比较。Native4x与Web1x质量差异显式登记：比较全覆盖内部像素的4样本平均值与Web中心深度，边缘采样差异仅允许发生于一像素几何边界；禁止图像重采样或强要求HDR材质相等。

预注册：实际上传VP矩阵最大元素误差≤2e-5；两端全覆盖且Web 3×3邻域局部平面中的深度均值误差≤2e-6，稳定内部比较像素≥64。Web邻域平面判定二阶差分≤2e-6，排除棱线MSAA混样；mask差异只允许1px边界。camera/source身份漂移、全clear、超过1px几何缺失及深度整体偏移1e-3负例均硬失败。需实际GPU确认生产深度样本均值与此合同相容；失败须定位语义，不拟合阈值。

VP还须各自匹配manifest预注册expectedVP，防止两端同时忽略相机却互相比过门。生成命令`node scripts/generate-j3-geometry-depth-manifest.mjs`经既有esbuild编译并直接调用正式cameraMath.lookAt/perspective/multiply，不另写相机公式。CPU双端同错VP负例硬失败；Native已有独立PlayerView/projection测试作为真源差异校验。

## 拟锁定文件

- 既有：native/tests/support/shader_material_renderer.rs、shader_material_observers.rs、gpu_shader_material_draw.rs（仅新test登记）。
- 新增：native/tests/support/j3_geometry_depth.rs、j3_geometry_depth_readback.rs；deep-engine/fixtures/j3-geometry-depth-v1.json、lab/j3GeometryDepthProbe.ts；scripts/j3-geometry-depth-parity.mjs、scripts/lib/j3GeometryDepthParity.mjs及其Node测试；本规格。
- 不改生产ForwardTargets/Renderer/shader/quality政策，不改已验收J3-E helper默认行为，不碰J5/C4/CSM/输出共享同步设施。新文件小于300行；root独占Cargo及GPU执行。

## 性能与范围

相机参数及观察只在测试入口启用，正常生产调用零额外读回。GPU采样和CPU跨端比较是验收成本，不宣称帧时收益。完整Gate D及材质/灯光/HDR色差、CSM、法线、透明、LOD、变形和后处理均未由本刀完成。

## 实现与入口

`node scripts/j3-geometry-depth-parity.mjs`默认清理旧native/web/evidence，执行当前具名Native GPU测试且要求非零passed及新JSON，随后执行Chrome生产PBR两相机各两轮。`--web-only`仅本次Web证据；`--compare`仅历史文件比较。截图在真实每帧读回完成且宿主仍驻留时生成。原Native帧helper的无options分支保持256²/frame_data(yaw=0)/默认shadow view；新options明确调用生产frame_data_with_camera及真实main depth编码观察，不改变生产quality或renderer。

按用户最新指令，视觉截图固定深色1920×1080；GPU数值附件仍固定128²，GPU工作量与预注册容差保持不变。

CPU对拍门：`node --test scripts/lib/j3GeometryDepthParity.test.mjs`，覆盖身份/真实VP漂移、全clear、深度+1e-3、缺失内部patch、错误布局和重复不稳定。稳定内部样本选择基于Web实际深度局部平面，Native深度偏移不会使自身逃出选择规则；mask差异须同时触及两端真实轮廓，不能靠缺失对象自己的边缘洗掉。GPU及完整旧默认回归由root串行执行，结果待回填。

首次实际运行拦下Native depth全零：既有encode_mesh_passes默认无透明时discard主深度，这个快路径不能用于帧后观察。FrameObservation分支改用已在生产HiZ消费的encode_opaque_pass(retain_depth=true)及原transparent pass；原默认路径保持discard。双方fixture角落须读出远平面clear 1，防止discard零初始化误算几何。相机/coverage/depth阈值保持预注册值。

## 实测结果

主线默认fresh双端runner已通过，`currentRun=true`、scope=`production-geometry-depth-interior`，证据为`test-output/interrupted-0930/geometry-depth/evidence.json`。两相机各两轮同宿主深度/VP/覆盖稳定，Native实际GPU具名测试通过。

| 相机 | 实际VP及参考最大误差 | 稳定内部像素/轮 | 深度均值最大误差 | Web/Native覆盖 | 合法1px轮廓差异 |
|---|---:|---:|---:|---:|---:|
| axis | 0 | 320 | 0 | 514 / 592 | 78 |
| oblique | 9.5367431640625e-7 | 258 | 1.1920928955078125e-7 | 534 / 591 | 57 |

共同包hash：`621d7355747b15ded4f0c128d10090ea4d0730a6b50f4df644a10991fb3cdb6a`；实际payload SHA-256：`e9f56e13905169dc866b6adc818809fc1883e5c684f1e1d71ccd97011d8f69f9`。Node7项负例/合同门、lab类型检查及真实依赖打包通过。已查看axis首轮截图，四个固定几何可见；同相机两轮数值稳定。最终视觉重拍使用深色1920×1080设置，GPU附件仍128²。完整Gate D、HDR材质、透明/LOD/变形、CSM/法线/后处理及全设备画质仍不在本刀通过范围。
