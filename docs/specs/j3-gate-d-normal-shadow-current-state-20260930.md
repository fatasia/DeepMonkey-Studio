# J3 Gate D：共同法线与阴影矩阵

沿用既有 geometry/depth 与 flat-normal HDR 的同一 RuntimePackage、两相机和85个预登记像素。双端正式normal附件已实际对拍；Web shadow真实附件与uniform已观察，双端阴影矩阵仍待对齐。

## 现状核查

1. **源码与未跟踪文件。** 已检查 `git status --short`，检索双方 src 的 normal、shadow、normal target、CSM 和恢复入口。已有 Web normal MRT、双端 CSM、Native shadow map 和既有 J3 lab；并行 C8、I 文件保持冻结。
2. **契约。** `RenderPacket` 已有 position-normal 顶点、实例变换、normalTexture、castShadow/receiveShadow。`scene/math.ts` 已有 inverse-transpose，CSM types 已有显式参数；不新增生产 ABI。
3. **依赖。** Vitest、esbuild、正式 cameraMath、TLAS、RenderPacket ray scene 已在包内；Native 已用 wgpu/bytemuck。无需新依赖。
4. **消费方。** `PbrRenderer` 的 geometry MRT 由 AO/SSR/TAA/volumetric/contact shadow 等路径消费；`ForwardTargets` 只有 HDR/depth/outline，缺 Native normal MRT。双端 CSM 正在真实生产绘制中消费；不新建替代 renderer。
5. **测试与证据。** 复核 geometry-depth、HDR flat-normal 规格和原 manifest，已有同包、两相机、四实例、深度与严格 HDR 子集。旧 common sun 禁阴影，且其方向下没有 cube→triangle 遮挡；旧样本不能覆盖 shadow。TLAS 及 CSM CPU/GPU 测试已有，不重复数学内核测试。
6. **规格。** 已读 09-30 handoff、恢复台账、Gate D geometry-depth/HDR-normal 规格。当前 final J5 source 身份冻结；本刀只新增未消费 lab/test 与此文档，由主线统一安排 GPU/Cargo。

**已有（不重建）：** RuntimePackage fixture、128²数值目标、camera expectedVP、85 个距边缘≥1.5px 的三角形 mask、camera unprojection、inverse-transpose、RayBackend TLAS、双端 CSM、production HDR/depth。

**真实缺口：** Native 材质 mapped normal 附件；Web 原 fixture 未启 geometry buffer；共同作者 shadow 参数、实际遮挡与 caster/receiver 开关读回。Web `CascadedShadowResources` 从 extent 派生 shadowFar/padding，Native `fit_light_depth` 还纳入 active_bounds；相同 planner 参数仍需真实上传矩阵核对。深度重建法线只描述几何，不能替代 mapped normal 附件。

## 本刀

新增 `lab/j3NormalShadowMatrix.ts` 与测试，直接 materialize 原 package 并核验原 hash。以原 mask 解投影、复用 TLAS 验证可见实例；由常量顶点法线与 inverse-transpose 产生 world/view normal 预期。法线 UNORM8 编码的量化界独立记录，当前 CPU 预期不算实际附件证据。

阴影保留原几何/材质/实例，作者 surface-to-light 改为 `[-0.6,-0.3,sqrt(0.55)]`，通过已有 TLAS 冻结遮挡预期。明确 1/4 cascades、mapSize=2048、maxDistance=40、splitLambda=0.7、padding=10、blend=0、depthBias=0.00075；光照方向与原 HDR gate 分开。覆盖 baseline、cube caster disabled、triangle receiver disabled。Ray offset=0.001 仅用于 CPU 几何遮挡查询，实际 shadow filter/normal bias 仍需读取生产 uniform，不能把二者当同一参数。

## 后续接线

主线程接手 Native 实际法线附件：复用 ForwardTargets、正式 mesh pass 与原18变体工厂，新增显式 capture 开关。默认仍单 HDR 附件，不创建法线纹理或额外管线；开启时只有 solid 六变体改为同一次 shade 的 color/worldNormal/roughness 输出，透明路径保持原配置。借现 FrameObservation/readback，法线取实际 mapped/oriented normal；Native frame.view 是 VP，保留 ABI，Web 实际 view normal 使用正式相机基转换到 world 比较。此阶段消费范围为内置 opaque 材质的诊断观察，custom shader 与完整阴影矩阵另验。源码所有权为 root 的 forward_targets、pipeline/mod+mesh、mesh_pass、native_mesh shader、既有 Native observer support；Web 新叶子/矩阵由 j3_recovery 持有。

先用本矩阵接真实 Web normal/shadow 观察；Native 需在正式前向管线加一致法线附件接缝，并观察真实 shadow uniform/map/可见度。法线 first cut 只覆盖无 normalTexture 的固定平三角；smooth/normal-map/TBN/double-sided 另扩。阴影按实际 PCF 与 bias 的稳定内区冻结比较域，不能按近似颜色筛点或扩大原 HDR 容差。

数值目标保持128²；视觉只用深色1920×1080双轮。产品视觉对标Unity管线与西门子工业表达，UI沿用base.css。实际附件证据和诊断截图见下节；产品画质另验。

## 实际法线附件首刀

主线在Native正式 `ForwardTargets`、mesh pipeline、opaque pass和原 `native_mesh_v1.wgsl` 接opt-in normal MRT。默认档仍无normal资源/额外pipeline；同一shade一次输出color与mapped worldNormal/roughness。`FrameObservation.capture_normals`沿现生产mesh装配观察；无新增renderer，也不扩frame ABI。

`j3_normal_attachments.rs`每相机先跑原默认档，再跑capture两轮，验证默认无normal texture、default/capture完整HDR字节相同、整张normal附件两轮字节相同、原85点独立CPU +Z预期及roughness alpha。Root实际具名测试PASS（GPU4.21s），必要production材质/LOD/custom/透明控也PASS。

Web新 `j3NormalShadowProbe.ts` 用既有deformation capability启geometry MRT，packet不变形，AO/TAA/SSR/fog/IBL均关闭；两camera×1/4CSM×三caster/receiver情景×两轮共24帧。新compute只读取真实normal/linear-depth/HDR与CSM uniform/map，并调用现canonical CSM helper。原viewNormal按正式实际worldToView转换到共同world域，Native读真实worldNormal。

`node scripts/j3-normal-shadow-parity.mjs --web-only`实际PASS（7.8s），不重复root已执行的Native。随后CPU比较两份本轮原始附件PASS：双端最大world-normal角0.4071987039234767°，各端对独立CPU预期最大0.3177554231316584°。UNORM8单端decoded component half-step=1/255，单端角界0.38917633049702727°，双端角门=两端量化角界+.01°，在GPU执行前冻结，未按结果调参。

两端均为同device两轮draw；独立执行记录不等于统一runner默认fresh执行。`paired-normal-result.json`明确各腿来源且currentRun=false。默认runner会清旧Native/Web证据并执行具名Native后Web，只在两端当前执行、比较与源身份稳定后发布currentRun=true。Web-only证据不合并旧Native为通过门。

证据均在 `test-output/interrupted-0930/normal-shadow/`：native.json、web.json、cpu-plan.json、evidence.json与paired-normal-result.json。Web baseline两camera×两CSM×两轮8张深色1920×1080图；已检查oblique csm4双轮，固定128²画布放大到512²显示，画面有预期两cube与两triangle且重复稳定。这是数值诊断画布，产品布局/交互/动效等10维视觉评分不适用；本刀交付范围为附件一致性，不计产品画质验收。

## 实际阴影诊断与下一刀

下一刀复用同一生产HDR，无第三MRT/新shade：Native观察宿主增加已有CascadedShadowOptions显式profile和实际ShadowMap回调。现Native采样uniform已具备COPY_SRC，不改生产ShadowMap；按其正式21 vec4/336B读取，Web39 vec4/624B分别解码，再比较共同语义。每点记录实际baseline HDR与同包同frame关闭阴影的HDR，按binary16相邻数中点推导可见度区间；原85点全保留，Web helper仅作诊断。Native默认profile已是far40/map2048/padding10，只需显式合法2/4级联和blend0，不重建planner；场景bounds差异仍记录。来源/矩阵/采样合法差异不通过拟合epsilon抹平。

Web真实CSM uniform读回156 floats，核对cascadeCount、bias=.00075、map2048、far40。`view.far=40, extent=50`使现生产资源派生shadowFar40、padding10；原xy像素域保持，实际VP按正式cameraMath的新far40核验。

| 案例 | 原TLAS挡点 | 实际visibility<.5 | PCF部分点 |
|---|---:|---:|---:|
| axis / csm1（45点） | 15 | 15 | 9 |
| oblique / csm1（40点） | 17 | 14 | 10 |
| axis / csm4（45点） | 15 | 15 | 0 |
| oblique / csm4（40点） | 17 | 16 | 4 |

cube caster关闭后原85点均为visibility=1。baseline实际HDR除以receiver-disabled实际HDR，各RGB ratio与相同实际map的canonical helper最大差为axis1 .0006301、oblique1 .0015554、axis4 0、oblique4 .0029269。该ratio可复用为下一Native shadow首刀的生产输出路径，误差预算需从half量化独立推导。

原二值TLAS不是PCF+normal bias的参考公式。csm1 oblique的7375/7503/7631为.622/.638/.654部分可见，csm4 oblique的7631为.513。保持85点完整观测，后继按先验shadow footprint记录边界，不按实测误差删点；当前shadowParity=false。normal-map、smooth/double-sided全材质法线及双端shadow/HDR全域仍未收口。

## 验证

主线检查：Native目标编译通过；实际normal测试1 PASS，production材质/LOD/custom/透明控制2 PASS（11.61s）；WASM bundle已按新Native源指纹重建。root复核矩阵6测、Node比较器6测及两轮oblique截图。共享TS产物随I-C18最新冻结源重建，不引用中途WIP的freshness失败为当前完成结论。

`pnpm --filter @bim-studio/deep-engine exec vitest run lab/j3NormalShadowMatrix.test.ts`：6 PASS；`tsc -p tsconfig.lab.json --noEmit` PASS。

CPU 产物 `test-output/interrupted-0930/j3-normal-shadow-cpu.json` 含8行×3场景。原85个点全部通过真实可见实例查询：axis regular 的21点中15点被原第二cube遮挡，oblique regular 的22点中17点遮挡；两个 mirrored 区域24/18点全部为无遮挡对照。关闭cube caster后85点全部无遮挡；关闭triangle receiver后85点全部不受影。world normal均为+Z，oblique view normal沿正式camera基旋转，UNORM8独立量化角界约0.389°。

CPU计划仍标 `currentRun=false`、actual normal/shadow attachments=false；新GPU观察为另立原始证据。矩阵Vitest6PASS、normal比较器Node6PASS、lab tsc/node syntax/rustfmt均PASS。Native生产源与Cargo/GPU由root执行，本专线只新增Web lab/runner/lib/tests和Native独立测试叶子，既有manifest与已验runner保持。

## 主线程fresh联合收口

`node scripts/j3-shadow-visibility-parity.mjs` 已执行 Native normal一次、Native shadow一次及Web24帧一次，使用同一Web读回同时比较；passed/stable/currentRun=true，source identity前后一致。法线最大world角0.4071987039234767°；共同4级联170样本阴影区间零差。此前prior receipts只作历史诊断。J5已加入此正式子集的第14对双腿；完整材质Gate D后继不变。
