# J3 Gate D：HDR 与法线现状、最小后续切片

本规格用于扩展已通过的共同 geometry/main-depth 门。先定位同包同相机的生产 HDR 差异，再定义能够逐项复核的共同着色输入；完整材质与法线门仍未完成。

## 现状核查

1. **全仓与未跟踪文件。** 检索 `packages/*/src`、`apps/web/src` 的 `HDR`、`normalTexture`、`PbrRenderer`、`FrameUniform`、`geometryOutput`，读取 `git status --short`。已有 `j3GeometryDepthProbe.ts`、Native `j3_geometry_depth.rs` 与真实生产绘制观察入口；本轮并行 C8/雾/物理改动不属于此切片。
2. **契约。** `renderPacketTypes.ts` 已定义法线、切线、normalScale、线性 emissive；`PbrFrameUniformView` 与 `RenderView` 已定义相机、曝光、环境和作者灯光。Native `DirectionalLighting` 已有 `validate/apply`，不新增帧 ABI 或灯光类型。共同 geometry manifest 已记录正式 cameraMath 生成的 expectedVP、同包/packet hash 与 128²目标。
3. **依赖。** 现有 wgpu 30.0.1、pollster、serde_json、half decode、esbuild、Playwright 足够完成读回与数值分析，无新依赖。
4. **消费方。** Web `PbrRenderer → pbrFrameUniforms → pbrShader`、Native `frame_data_with_camera → GpuScene/MeshPipelines → native_mesh_v1.wgsl` 均实际消费。产品 `StudioDeepWebGpuBridge` 已消费 Web 渲染能力。Native 测试 helper 复用生产 shader factory、场景/材质资源、culling/LOD、前向与阴影 pass；只能补观察接缝。
5. **测试与证据。** geometry-depth 已有两相机两轮真实双端 GPU 门；同相机 VP/覆盖/稳定内部 depth 已通过。Web 读回生产 rgba16float HDR，但 JSON 仅保留非背景像素数；Native `Snapshot.hdr` 已保存真实 half 字节，JSON 同样未保存 RGB 数值。白炉已有生产 HDR/BRDF GPU 测试，可复用语义与 half 解码，不能把另一场景白炉当成本 manifest 的证据。
6. **规格。** 阅读 `J3-双端RenderPacket对拍门规格-20260929.md`、geometry-depth/spec/output-first-cut、09-30 handoff 和恢复台账。Gate D 全门要求线性 HDR 与辅助 normal/depth/shadow 分项；现有输出与 geometry/depth 门不重复建设。

### 已有（不重建）

- 同一个 `runtime-package-v1.json`、同 packet identity、正式相机投影、两轮真实绘制、GPU 错误/超时/非空判据。
- 生产 HDR 与硬件 depth 附件读回；Native 4x MSAA、Web 1x 的有限合法边界规则。
- Web 作者 directional/cluster 灯光与 Native 作者 `DirectionalLighting::apply`，无需另造 shader/灯光实现。
- 默认 Gate E、CSM 和 geometry/depth 测试入口；新增诊断配置必须保持默认行为。

### 真实缺口与可解释差异

当前 geometry 门只有相机/包相同，**灯光输入并不相同**。Web 省略 lights 时使用主灯 ray `[-1.6,-2.8,-1.2]`、颜色 `[2.5,2.4,2.25]`，另有次 directional；fixture 配置 `environment=false`。Native `frame_data_with_camera` 保留 legacy 固定太阳 `[3.2,3.0,2.8]`、不同方向与 IBL 开启。现有非空 HDR 不能据此称为材质色彩对拍。

即使统一单灯、禁用阴影/IBL，Web 生产 `shade` 还会给粗糙度增加 `deepGeometryRoughness(normal)` 的 dpdx/dpdy 项，Native 当前没有该项；Web 下限 0.06、Native 0.045。本包材料 roughness 0.28/0.34，不触及下限，但 smooth cube 法线的导数项依然可能产生差异。此处为源码确认，幅度尚未做本 fixture 实测。不得按实测色差反向拟合曝光或放宽容差。

**Native ForwardTargets 没有 normal MRT。** Web rgba8unorm view-space normal MRT 仅在 AO/SSR/volumetric/TAA/contact-shadows/deformation 路径开启，当前 geometry fixture 全部关闭。不能把几何 depth 重建法线写成材质 mapped normal 的生产读回，也不能新建替代 normal renderer 冒充已有前向附件。normal 独立门需后续真实 Native 接缝设计。

## 最小拟实施范围

先复用现 geometry fixture 增加可选 HDR 诊断：保存真实 RGB 与实际上传 lighting/frame identity，保留原 depth/VP 门与 default probe 行为。两种配置为原宿主默认档及共同作者单灯档；共同档固定 surfaceToLight `[0,0.6,0.8]`（已单位化）、radiance `[2.5,2.4,2.25]`、intensity/exposure=1、无 local/ambient/hemisphere、无 IBL/GI/shadow/fog。Native 通过现作者 `DirectionalLighting::validate/apply` 消费，只加 test-only frame 配置；Web 通过已有明确 `lights` 的 ray `[0,-0.6,-0.8]`、color/radiance 与 castShadow=false 消费。双方必须输出实际上传 uniform 并与该清单核对。

两轮共同档 HDR 必须有限、非空且稳定；默认宿主对照只执行一轮用来解释差异。固定 flat-normal 三角形成为本刀可交付严格子集：`generate-j3-hdr-manifest.mjs` 从原 packet 的 regular/mirrored triangle vertices/indices/instance transform 及正式 cameraMath 冻结 expectedVP 生成 mask，像素中心距三条边均≥1.5px。axis 两区域 21/24 点，oblique 22/18 点，每区域≥16点；mask 在GPU执行前写入 `j3-hdr-flat-normal-v1.json`，不按实际颜色或相近误差选点。

预注册严格 RGB 门：最大通道差≤0.002、固定 peak=1 的 PSNR≥60dB、三个通道统计 SSIM 均≥0.9999。每个冻结 mask 点必须仍被两端实际 depth 覆盖，四个 Native samples 均有效；漏绘不能靠筛点消失。共同灯输入任一漂移、两轮 HDR 不稳定、错像素/色差 0.01/两端一起忽略作者灯均应硬失败。全共同稳定 depth 内部仅输出 HDR 差异诊断；smooth cube 导数粗糙度的合法差异保留独立描述，不据此声称全材质门通过。

不修改主 renderer、production shader、帧 ABI、normal MRT 或默认设备策略。此切片无生产性能路径变化，不开无价值帧时 benchmark。真实 GPU/Cargo 仅由主线串行；截图仅深色 1920×1080，128²数值目标保持。

## 拟锁与验证

本新规格、`lab/j3GeometryDepthProbe.ts`、Native `tests/support/j3_geometry_depth.rs`/`shader_material_observers.rs`、`scripts/j3-geometry-depth-parity.mjs`，以及必要新增小 HDR 比较器/Node 负例测试。默认选项保持既有 geometry/depth/E/CSM 行为，新文件小于 300 行。

主线已批准上述 test-only 接线。新增 generator/fixture/HDR比较器均限此共同切片。agent 跑 Node/类型/静态检查；主线运行 fresh 双端 runner，实际结果见下文。

## 实现与实际验证

正式命令为 `node scripts/j3-geometry-depth-parity.mjs --hdr`。无 `--hdr` 的 geometry/depth 默认门不变；`--hdr --compare` 仅历史比较，要求原 manifest identity 保持，不能作为本次运行证据。默认清旧证据后执行真实具名 Native target，再采 Chrome；两端各两相机×共同档两轮与默认宿主档一轮。

增加独立 CPU 直接光下界，避免两端全黑同 uniform 假绿。原 triangle 材料 `metallic=0.72`、base `[0.86,0.28,0.055]`、无 emissive，平法线 `+Z` 与实际 sun 的 nDotL=0.8；CPU Lambert 项 `(1−metal)·base/π·nDotL·radiance` 为 `[0.153298041186,0.047914550547,0.008823550045]`。生产 BRDF 的 spec 项非负，本共同档无 IBL/local/diffuse/fog，因此每个严格像素的实际 RGB 至少达到此项，允许的 half 量化误差仅 `max(floor/1024,1e-6)`。该下界从输入推导，没有按实测改 mask 或放宽原误差阈值。

主线最终 strict J5 **12对24腿通过、degraded=false**，`evidence-20260930071057.json`；HDR fresh `currentRun=true`。四子集两轮最大/均值 RGB 误差均0、SSIM=1、PSNR为无限（JSON `exact=true/psnr=null`）。每端共170个严格像素、510个通道值；两端合计340像素、1020通道值。实际 RGB 各区域范围：axis regular `0.019821–0.341797`、axis mirrored `0.014122–0.243042`、oblique regular `0.012123–0.207764`、oblique mirrored `0.010994–0.186768`；实际非零 sun 贡献及 CPU 下界均通过。

全共同覆盖区域仅作诊断：axis 485点、common max=5.4375/default max=7.005859375；oblique 477点、common max=2.2109375/default max=3.09423828125。该集合含平滑法线与不同 MSAA 边缘，不是严格平三角 mask，也不等于材质全等；不能把这些差异全部归为单一导数项。法线 MRT、完整 IBL/GI/shadow/材质家族仍在排除项。

当前 raw fixture SHA-256=`3b15f6a35519406d6fd027daece3e847985b39c3eb1a211c57c7bd2208b28955`；Web 完整正式 sceneShader SHA-256=`68bac187c6105ba446571c3243c9d0112bada5702fd8f91ca19b175e1430cec9`；Native 生产 factory 输入按实际当前顺序拼接 SHA-256=`23c7ef4118df9633f228cd28b0f860720d0bea1ab0b1ae230ec20add02a49f00`。身份及实际上传 lighting uniform 随两端 JSON 保存。

`node --test scripts/lib/j3HdrFlatParity.test.mjs scripts/lib/j3GeometryDepthParity.test.mjs` 15项通过：max/PSNR/SSIM独立负例、两端同黑/同错误太阳、漏几何、隐藏额外灯、重复不稳定、原相机/深度负例。lab tsc、rustfmt、JS语法与改动空白检查通过；新/改文件均<300行。已查看 axis round0 与 oblique round1 实际截图，均深色1920×1080、两立方体及两三角形完整可见。128²为数值研究附件，不是产品场景画质评分。

本刀严格 authored-single-sun/flat-normal-triangle HDR 子集完成。证据 `test-output/interrupted-0930/hdr-flat-normal/evidence.json`；生产 normal 附件门和完整 Gate D 未完成。
