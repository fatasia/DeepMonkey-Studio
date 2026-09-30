# Z1 默认画质审计（第二刀：真机逐参数实测）

> 2026-09-30。验收口径（用户定死）：**零配置（新建场景→拖模型→不动任何设置）即 Unity/UE 第一梯队 + 丰富预设 + 高度灵活细调**。
> 第一刀（骨架+已证事实）见 git 历史；本版为 **20260930 第二刀实测**：第一刀对照表中全部未测项已由真机 harness 逐参数读出并替换为实测值，
> 测量边界与无法测量项如实标注。Z2 零配置样板验收以本表为清单。

## 0. 第二刀测量记录（20260930）

- **harness**（零产品代码改动，均不入库域）：
  - `test-output/z1-default-quality-20260930/z1-probe-entry.ts` — 挂载产品 `ViewerEngine`（作者 Viewer 固定 WebGL，对齐 `useAppRuntimeEffects.ts:299` 生产口径）+ 产品 `StudioDeepWebGpuBridge`（含 `authorRenderPacket` → 独立 RenderPacket 路径，`compileSceneRenderPacket` + `browserImageDecoder` + `normalizeStudioWasmModel` 同参）+ 产品 `StudioDeepRenderView` 读 Deep 每帧真实消费的 RenderView + T25（`readStudioQualityTelemetry`）/F1（`getPerformanceSnapshot().deep`）面板等效数据。
  - `test-output/z1-default-quality-20260930/z1-default-quality-test.mjs` — esbuild 打包 + 静态伺服 + playwright-core(headless Chrome `--enable-unsafe-webgpu`)，双轮 A/B 复现检查，evidence.json 落盘。模式复用 `test-output/hc5-t-visual/` 与 `packages/deep-engine/scripts/shadowPagingQualityGpuTest.mjs` 两先例。
  - fixture `fixture-procedural-box.glb`：harness 程序化生成（确定性字节，sha256 记入 evidence）。第三方样本被 Deep GLB fail-closed 合同逐个拒收：Kenney nature-kit 全系 `KHR_materials_unlit` 不支持、DamagedHelmet 无 TANGENT 推导失败（简并 UV）、a1811-debug 镜像 UV 缝——合同严格性本身是测量发现。
- **证据**：`test-output/z1-default-quality-20260930/evidence.json`（schema `z1-default-quality.v1`，gate PASS 12/12）+ 12 张截图（暗/亮主题、TAA f1/f8/f32 收敛序列、GI-off 对照）。
- **可重复性**：双轮 A/B 配置/状态/恒等字段逐项一致；12 张截图逐位一致（sha256 相等）；两次完整运行 gate 均 PASS（帧时/设备内存字节按波动字段豁免，差异可解释）。headless Chrome + WebGPU，适配器信息不可读（`adapter.info={}`），性能读数仅参考、画质语义字段有效。
- **零配置语义**：引擎内建即零配置（`viewerEngineCore.ts:331/343` 直接 `structuredClone(DEFAULT_LIGHTING/DEFAULT_POST_PROCESSING)`），探针不调任何画质 setter（唯一例外：为触发懒创建的作者 Composer，以同值重放一次 `setPostProcessing/setGlobalLighting`，对齐工作区建场景时 `applySceneViewerSnapshot` 的必经调用，值零漂移）。

## 1. 已证事实（来自已提交切片，附证据）

| 轴 | 我们零配置现状 | 证据 |
|---|---|---|
| 渲染后端 | Deep（WebGPU）为默认（原 WebGL）| Z1.5-P0；**第二刀真机**：`initialRendererBackend(null,null)="webgpu"` → `switchTo("webgpu")=switched`，`activeBackend=webgpu` |
| 阴影档 | 四档接桥（替代硬编码 1×1024）| Z1.5-P1；**第二刀真机**：`FrameMetrics.shadowTier="exact", mapSize=2048, cascades=1`（见 §3 缺口 4：exact ≠ high）|
| IBL 兜底 | 黑 IBL→中性环境 | Z1.5-P3 |
| 自动曝光 | mip 亮度代理自动曝光（F8）在库 | `pbrAutoExposure.ts`；**第二刀真机**：默认未接线（§3 缺口 1）|
| 动态分辨率 | opt-in 已接（T07/P5）| 74432bca；**第二刀真机**：`resolutionScale=undefined`（默认关）|
| 接触阴影 | C10 屏幕空间接触阴影在库 | 阴影族合同；**第二刀真机**：`FrameMetrics.contactShadowTier` 缺省=默认关 |
| 介电/清漆/面积光 | F0 单源、clearcoat、LTC 面积光 | J2-B1/C3/C9 |
| 大气天空 | 物理散射+三时段 harness 16/16 PASS | C6 |
| 帧诊断 | 逐 pass GPU 计时（8/16 查询对）+ T25 面板 | F1/T25；**第二刀真机**：`gpuPassTiming` 默认关（`latestPassTimings` 缺省），`frameGraphReceipt` 未随常规帧露出（§3 缺口 6）|
| 能量守恒 | 白炉门进 J5 双端验收 | C12/J5 |

## 2. 对照表（我们默认 vs Unity HDRP / UE5 默认；✅=实测具备默认接入，⚠️=能力在库默认未开，❌=缺）

> 「我们」列全部为 20260930 真机实测值（evidence.json check 名随行标注）；HDRP/UE5 列出处见 §2.1。

| 轴 | Unity HDRP 默认 | UE5 默认 | 我们（20260930 真机实测） | 判定 |
|---|---|---|---|---|
| Tonemapping | Volume override 组件默认 **None**（源码实锤 `TonemappingModeParameter(ToneMappingMode.None)`）| 内置 filmic tonemapper 默认开 | **ACES 双端默认开**：作者 `renderer.toneMapping=ACESFilmicToneMapping(4)`、曝光 1.05；Deep features `toneMapping="three-aces-r185"`（`tonemapping-aces-default-on` PASS）| ✅ 达标（强于 HDRP 组件默认口径）|
| 曝光 | Volume override 组件默认 **Fixed(0)**（源码实锤 `ExposureModeParameter(ExposureMode.Fixed)`）；自动曝光需显式配 Automatic | 自动曝光（Eye Adaptation）默认开 | **固定 1.05**：`view.exposure=1.05`，`FrameMetrics.autoExposure` 缺省=F8 未接线（`auto-exposure-default-off` PASS）| ⚠️ 缺口（§3-1：对齐 UE 自动曝光口径需把 F8 接进桥，fail-closed 回退已在库）|
| GI | 无默认 GI（APV 需 HDRP asset 手动开启+烘焙）| **Lumen 默认开**（官方："Newly-created projects have Lumen Global Illumination and Reflections enabled by default"）| **探针 clipmap GI 默认开且实际出图**：`globalIlluminationEnabled=true/0.32`，`probeClipmap requested+active, radianceSource="scene", committedBatches=17`（`gi-default-on-active` PASS）；方向数默认 32（代码口径 `probeDirections=undefined→32`，G3/F5 授权）| ✅ 达标（对齐 UE 口径，且为实时探针、无需烘焙）|
| 反射 | SSR 默认关（需加 Volume override+HDRP asset 启用）| **Lumen 反射默认开**（同上官方句）| **默认关+能力就绪**：`post.screenSpaceReflection=false`，`view.postProcess.screenSpaceReflection=false`，capability=true（`ssr-default-off` PASS）| ⚠️ 决策项（§3-3：HDRP 口径已达标；追 UE 需默认开+成本门）|
| 阴影 | 级联+PCSS 软阴影默认 | **VSM 默认**（官方："New projects use Virtual Shadow Maps by default"）| **exact 单级 2048**：`shadowTier="exact" mapSize=2048 cascades=1`（`shadow-tier-measured` PASS）；作者光 `mapSize=2048, radius=3, blurSamples=8`（WebGL 回退为 PCF 软参）；Deep 级联无 PCSS/软阴影滤波；接触阴影在库默认关 | ⚠️ 缺口（§3-4：软阴影档；§3-5：接触阴影默认档决策）|
| 抗锯齿/分辨率 | TAA 默认 | **TSR 默认**（官方："TSR being enabled by default"）| **TAA+SMAA 默认开、动态分辨率 opt-in 关**：`temporalAa=true, spatialAa=true, resolutionScale=undefined`（`taa-default-on-dynamic-resolution-off` PASS）；TAA 收敛序列 f1/f8/f32 截图逐位收敛 | ✅ 达标（TAA 对齐；TSR 类时域超分 F4 在库 opt-in，未默认开）|
| 雾/氛围 | 默认无雾 override（文档页不可达，按 Volume 组件默认口径）| 新模板场景含 ExponentialHeightFog 默认对象 | **exp2 天气雾默认开**：`view.fog={kind:"exp2", density:0.0018, color linear≈[0.3467,0.5395,0.6584]}`=合同 v1 sunny `#9fc2d4`（`fog-default-weather-sunny-exp2` PASS，引擎初始化 `setWeather("sunny")` 写入）；**体积雾默认关且参数被 setter 剥除**（`fog-capability-volumetric-default-off` PASS + §3-2 缺陷）| ✅ 达标（氛围雾默认有）+ ❌ 缺口（§3-2）|
| 材质默认工作流 | Lit=金属度粗糙度 | Lit=金属度粗糙度 | glTF PBR 直通（fixture metallicFactor/roughnessFactor 直渲出图，`scene-sanity` PASS：triangles=25、packetInstances=1）| ✅ |
| 后处理栈 | Bloom/Vignette 需 Volume override，模板 profile 为准（文档页不可达）| Bloom/色阶/Vignette 默认开 | **GTAO 默认开（0.72）**，`view.postProcess={ambientOcclusion:true, screenSpaceReflection:false, bloom:false}`；Deep features bloom/vignette=true 但 per-view 关；SMAA 默认开（作者 smaa=true）| ⚠️ 决策项（§3-6：Bloom/暗角默认档，先过 B6 单源对拍）|

### 2.1 HDRP/UE5 默认值出处

- **UE5 Lumen**：Epic 官方文档 *Lumen Global Illumination and Reflections in Unreal Engine*（dev.epicgames.com/documentation/en-us/unreal-engine/lumen-global-illumination-and-reflections-in-unreal-engine）："Newly-created projects have Lumen Global Illumination and Reflections enabled by default"。
- **UE5 VSM**：*Virtual Shadow Maps in Unreal Engine*（同域 …/virtual-shadow-maps-in-unreal-engine）："New projects use Virtual Shadow Maps by default"。
- **UE5 TSR**：*Temporal Super Resolution in Unreal Engine*（同域 …/temporal-super-resolution-in-unreal-engine）："TSR being enabled by default"。
- **HDRP Tonemapping/Exposure 组件默认**：Unity 官方源码仓 Unity-Technologies/Graphics（发布物即官方口径）`Packages/com.unity.render-pipelines.high-definition/Runtime/PostProcessing/Components/Tonemapping.cs`（`mode = ToneMappingMode.None`）、`…/Exposure.cs`（`mode = ExposureMode.Fixed, fixedExposure = 0f`）。注意两层口径：上表为 **Volume override 组件默认**（源码实锤）；HDRP 模板场景 Global Volume profile 的覆盖值在模板仓，本次不可达（Unity 文档站页面 404、搜索服务限流），如实标注。
- **诚实条款**：HDRP SSAO/SSR/雾的组件级默认本次未取到官方源码/文档原句（检索通道限流），该三格 HDRP 口径沿用第一刀判断并标注「未逐字核验」；后续补核不动摇「我们」列实测值。

## 3. 缺口清单（Z2 前必须逐项闭环；「补什么」已写明）

1. **自动曝光接线（F8 → Deep 默认）**：`StudioDeepWebGpuBridge` 的 create renderer options 补 `autoExposure`（`pbrRendererTypes.ts:85-92` 已点名「默认切换(Z1 提案 P0)与桥接线留主线」）。零配置默认开；studio 程序环境/无源时 fail-closed 回 `view.exposure` 固定 1.05（引擎已内建），遥测走 `FrameMetrics.autoExposure`。对齐 UE 自动曝光口径。
2. **体积雾 setter 剥字段（缺陷级，非画质决策）**：`viewerEngineRig.setPostProcessing` 归一化不落 `volumetricFog/volumetricFogSteps/volumetricFogDensity/volumetricFogHeight/volumetricFogAnisotropy`（`getPostProcessing()` 实测返回键缺省），而 `readStudioDeepPostProcess` 恰以该 state 为源 → **Deep 呈现路径体积雾参数被 setter 静默丢弃，实际不可开**。补：五字段透传+clamp；随后再决策体积雾默认档。
3. **SSR 默认策略**：默认关=对齐 HDRP；追 UE（Lumen 反射默认开）则默认开+首启帧时门（SSR Steps 32/Thickness 0.01/MaxDistance 2 参数已接）。Z2 拍板，二选一，不允许「默认不测」。
4. **软阴影档**：Deep 级联零配置实测 `exact/1×2048` 硬采样（四档 `high=4×2048` 仅在无作者阴影意图时兜底，带默认主光即回 exact）；HDRP 默认 PCSS、UE5 默认 VSM 软影。补：引擎级软阴影滤波档（PCSS/半径滤波）接入级联阴影并定默认档。
5. **接触阴影默认档**：C10 在库默认关（`contactShadowTier` 缺省实测）。定「balanced/quality 默认开」或维持 opt-in，与落地接触感验收（Z1 审计 §4.1）联动。
6. **Bloom/暗角默认档**：零配置 bloom=false、vignette=false（对标山海鲸/Unity 的「空气感」通常默认 bloom 轻开）。前置：B6 bloom/雾单源对拍（J 级尾巴）先于默认值切换。
7. **FrameGraph receipt 常规帧露出**：`FrameMetrics.frameGraphReceipt` 实测常规帧缺省 → T25 passCount coverage=unavailable。补：计划执行回执随常规帧带出（或 T25 面板如实维持 unavailable 文案）。
8. **逐管线编译耗时运行期不可达**（测量边界）：`pipelineCompileRecords` 只在 create 时经 `PipelinesBuild` 被 bootstrap 消费，运行期公共诊断面无只读快照。若 Z2 要「逐管线耗时」面板，需 `PbrRenderer` 增加公共只读 snapshot（产品改动，Z2 立项）。

## 4. 测量计划（20260930 结账）

- ~~F1 逐 pass 计时 + T25 面板读数 → 零配置首启帧构成~~ → 已做：`getPerformanceSnapshot().deep`（FrameMetrics 全量：shadowTier/mapSize/cascades/occlusionCulling/postProcessPasses/lightCount/lightClusters/resolutionScale/autoExposure）+ `readStudioQualityTelemetry`（activeProfile=null、sampleHz、coverage、latestMemory）。gpuPassTiming 默认关（F1 opt-in 语义实测确认），逐 pass 计时未在零配置帧构成中。
- ~~白炉/J5 门全绿作为底线回归~~ → 不在本刀域（J5 门独立执行，未动）。
- ~~真机对照序列脚本沿用 C6/F5 harness 模式~~ → 已做：本刀 harness 即该模式（esbuild + 静态伺服 + playwright-core + evidence.json + 双轮复现）。

## 5. 遗留边界（如实声明）

- 本刀 harness 的作者包为「新建场景+一个 GLB 模型」最小 SceneSnapshot（零配置值缺省），非整工作区 UI 驱动；工作区首启在 packet 路径上的差异仅 t11 首帧管线引导（harness 已同参启用 firstFrameSubset+deferDeformation），不改变任何帧画质语义。
- 截图中的黄色斜线为引擎内建辅助图形（零配置默认行为），不在本刀判定域。
- gi-off 对照截图在单盒场景视觉差异细微；GI 默认生效的判定以 probe 诊断（requested/active/radianceSource/committedBatches）为准，不以该图为准。
- 适配器信息（`adapter.info`）在本 headless 环境不可读；evidence 记录 fps≈49–114 为参考值，不构成性能判定。
