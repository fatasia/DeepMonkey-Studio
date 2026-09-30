# J2-B6 实帧后继核查

日期：2026-09-30。复用已经交付的 Bloom/Fog 生产数学与 J3 附件入口，先补共同作者 exp2 的实际 HDR/材质开关，再扩非均匀 Bloom 的合法 profile 矩阵。

## 现状核查

| 六步 | 已有（不重建） | 真实缺口 |
|---|---|---|
| 1. 全仓源码与未跟踪 | 已检索 packages/apps Bloom、Fog、softKnee、prefilter、HDR 消费与 git status。TS BloomPass/AuthorBloomPass、Native BloomPass、四输出变体、作者雾和两个体积路径均已有生产消费。 | 当前 J3 几何/HDR/normal/shadow 夹具关闭雾及 Bloom；没有同场景双端开启后的完整逐像素/profile 证据。C8/I 在途源不由本刀改动。 |
| 2. 契约层 | contracts 场景有天气 exp2、后处理 Bloom/体积雾参数；TS BloomOptions/PbrFog 与 Native BloomSettings/FogSettings 已定义合法域，material.fog 为作者显式布尔开关。双方 instance ABI bit32 都表示禁用雾，bit64 为 unlit。 | Native authored exp2 片元分支没有检查 bit32；Web 正式分支已有该早退。Fog 相同名称不表示坐标/相位/合成模式相同。 |
| 3. 依赖 | 现有 wgpu30/bytemuck/half/serde_json 与 WebGPU/Vitest/esbuild/Chrome，以及公共 WGSL 同步器足够。 | 不新增 profile 选择平台、渲染器或 GPU runner 框架。 |
| 4. 消费方 | Web PBR 使用 PBR_FOG_WGSL；postprocess chain 调正式 Bloom/作者 Bloom/体积 march+composite。Native mesh 消费 authored exp2，OutputPass 消费 exp/体积/bloom-fog，BloomPass 工厂装配共享软膝。J3 FrameObservation.configure/encode 提供实际 ForwardTargets/Frame/shadow，已有 Web geometry/HDR readback。 | Native observer 当前只读 mesh HDR，尚未在该同包夹具执行 Bloom/OutputPass；可在 encode 回调调正式 pass，无需新增 renderer。 |
| 5. 测试与证据 | bloomEnergyReadback 已运行生产 BloomPass 并支持任意 pixelAt；bloomEnergyProbe 有均匀/4²亮斑/alpha/资源回收。Native bloom_gpu 读正式 blurred texture，fog_gpu 读 OutputPass；各已真实通过。bloom-prefilter/fog-common receipts 各 passed/stable 两轮。 | 已验软膝 64 组和 Fog 标量 1024 组没有纹理边缘/整帧相位/相机验证；旧 Native fog_gpu 只断言颜色改变，不覆盖材质 opt-out。 |
| 6. 规格与恢复记录 | 已读 j2-b6-current-state、fog-common-math、J3 输出/geometry/HDR/normal-shadow规格、remaining、交接与恢复台账。 | 共享软膝、密度/透射和输出 profile 首刀均已完成，不能重做；实际模式/非均匀场景矩阵仍后继。 |

## 具体差异

Native `scene_pack.rs::surface_flags` 为 `fog=false` 打 bit32；Web `deepApplySceneFog` 查这个 bit 后立即返回。核查时 Native `native_mesh_v1.wgsl` authored exp2 分支只查 fogProjection.z==2，随后无条件 mix，未检查材料 bit32。主线程实际执行16帧，确认禁雾材质的完整 HDR 与 control 不同；`author-fog/native-before.json` 和 `author-fog-before.log` 保留失败证据。主线程在普通/RT两处片元补 bit32 guard 后，原 Native 16帧通过。

共同 authored exp2 使用相机正深度：Web `-(worldToView*world).z`，Native VP clip.w，并在 Native clamp>=0。固定相机前方三角点和曝光1时可直接对独立 `T=exp(-(density*cameraDepth)^2)` 参考。幕后点/曝光策略/透明合成另登记，不修改近远平面来制造相等。

TS 旧 Bloom 是整数5tap、多级 downsample/blur/0.5 upsample；Native 是半分辨率、线性采样的分数5tap、radius，然后 OutputPass 合成。TS 先平均再非负化，Native 每采样先非负化；Native软膝epsilon不同。作者 Rec.709 Bloom 为第三模式。共同参数域不意味着这三个输出逐像素相等。

Web 体积雾半分辨率/视图原点高度、HG带1/(4π)、albedo/lightRadiance散射+透射；Native 全分辨率 output 按世界eye高度、HG相对项 clamp0–4 和雾色mix。现 I-C18 已另接有遮挡的 god rays 生产路径，不属本 Fog 数学回迁范围。

## 最小首刀

1. 共同 authored exp2 实帧：沿用原 runtime packet/双相机/预注册85点，独立测试 packet 仅改材质为 unlit，曝光1，雾色取可精确半精度编码的线性RGB。Fog关闭、两个非零density、material.fog=false，共两轮；读取正式 HDR，独立 CPU 坐标+exp2参考，保留所有点。fog=false 必须和无雾 control 逐字节相同。先实际失败复现再补 Native bit32 条件，默认不开雾路径不变。
2. 精确文件域建议：new Web lab probe/comparer/runner 与 Native 独立 test leaf；Native 生产仅 authored exp2 那一行 guard及相关断言，FrameObservation 的 configure 已够用，不扩 ABI/support/材质packer。具体生产修改待主线程协调后实施。
3. 非均匀 Bloom：同一固定 rgba16f HDR 输入（均匀、亮斑、梯度、正负交界、边缘）送两端现 production pass。Web 复用 BloomPass/bloomEnergyReadback，Native 复用 BloomPass.output_texture/output_view + OutputPass，不抓私有GPU资源或改 shader。先分别记录两profile完整实际输出、alpha/能量/亮斑外扩/独立CPU采样参考，再量化合法差异；不得改radius/级数/容差追求事后相等。作者Bloom独立留矩阵。

## 实际首刀

新增 `j3-author-fog-v1.json` 固定四色配置：control、density 0.08、density 0.2、density 0.2且材质禁雾。线性雾色为 `[0.0625,0.25,0.5]`，曝光1，unlit消除直射BRDF差异；CPU/跨端绝对门均在运行前固定0.001。场景、两相机和45+40原始采样点沿用normal矩阵，独立CPU坐标和exp2公式计算期望。

2026-09-30实测：Native同device实际16帧，Web两个fresh device各16帧，每个配置/相机两次绘制。与Native原帧比较1360组点，最大CPU误差 `0.000463071851578567`，最大跨端HDR误差0。每端两次绘制和Web两个fresh device完整HDR哈希稳定；材质禁雾与control逐字节相同；相机VP、alpha、原像素/实例顺序和GPU错误均通过。Native不计为两个fresh device。

本次主线程Native与子线程Web分段运行，汇总 `test-output/interrupted-0930/author-fog/evidence.json` 明确 `currentRun=false`。统一fresh默认命令 `node scripts/j3-author-fog-parity.mjs` 顺序运行具名Native一次和两个fresh Web设备，只有该入口赋予 `currentRun=true`。`--web-only` 不执行Cargo/Native；`--compare` 仅比较已有receipt。失败保留诊断receipt/完整子日志，清除旧汇总。

Web source身份只包括esbuild metafile列出的实际Web/CPU依赖、夹具及本刀脚本；Native冻结src/assets与canonical WGSL全链保留。运行前后身份相同，不把无关编辑器/Gaussian新文件纳入消费闭包。

已检查两张实际深色1920×1080附件 `frame-oblique-density-high-fresh-0.png`、`frame-oblique-density-high-fresh-1.png`；标题/画布完整、同场景位置与雾色一致。这是低分辨率128×128数值诊断画布的实测附件，范围为opaque/unlit authored exp2。RT实际设备、幕后点、linear/体积雾、Bloom、完整产品画质与帧耗时仍后继。

CPU检查：lab TypeScript通过；matrix Vitest 2项、Node comparer 2项通过；runner语法和Native leaf rustfmt通过。新叶子域共9文件：fixture、matrix及test、Web probe、Native独立test、Node comparer及test、独立runner、本规格。主线程负责Native test注册及两生产shader修复；全局任务计数由主线程更新。
