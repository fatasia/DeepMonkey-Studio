# C8-S5 共同作者直射材质链

Deep正式主方向光复用已有DFG补齐直接多散射，并以未扰动视空间法线计算几何roughness；原Three r185作为固定质量基线。

## 现状核查

1. 全仓源码与未跟踪文件：S4 fixture/probe/readback/comparer已在树，ThreeProjectionBridge、materials、packInstanceBatches、pbrSceneLighting、canonical brdfDirectLighting与Three r185 ShaderChunk均已有；不复制renderer、投影或GPU读回。
2. 契约：已有PbrMaterial、RenderPacket、RenderView、WorldDirectionalLight和materialInstanceAbi。作者线性色彩/roughness/metal直接保存在packet，normal经inverse-transpose world变换，IOR1.5对应dielectricF0 .04。
3. 依赖：Three0.185.1、esbuild、Vitest、Chrome与GPU验证已在用；不建IR或新依赖。
4. 消费：作者方向灯经projectThreeWorldLights→resolvePbrSceneLighting，第一灯只作为primary，ray方向取反供BRDF；Three读取同light world位置/target、颜色/强度。材质经正式bridge→packet→实例ABI→shade，颜色不再次sRGB解码。
5. 测试与证据：S4两轮严格自发光maxHDR .000293/byte1/轮廓0；actual-direct HDR差 .023404/byte6。已有Three灯光/材质映射与GGX/Fresnel focused，尚未逐层归因这组实际场景差异。
6. 规格：读取S4/S3a/b/c与remaining C8。I在写pbrShader/pipelines/bindings/environment，J3在写renderer/Bridge恢复；最初保持这些生产源只读；根在I冻结后批准pbrShader/directDisplay与environmentShader最窄接线，renderer/Bridge仍只读。

**已有（不重建）**：同作者root、正式两后端、单灯投影、标准材质与world normal、真实HDR/surface读回、共有Schlick/Smith与严格emissive门。

**真实缺口**：Two hosts当前直接响应不是同一profile。Three r185在RE_Direct_Physical使用DFG LUT的GGX多散射补能；Deep使用single-scatter。Three几何roughness取view-space normal的屏幕导数分量max，Deep取world-space；分量max不具有旋转不变性。另roughness下界.0525/.06、NV下界0/.0001、NDF分母未clamp/1e-6各有合法边界差异。输入映射已存在，不能把公式差异改成默认统一。

## 最小切片与冻结门

用户随后明确Deep偏亮且光泽不足：质量交付必须保持原Three r185对照、改善Deep完整生产直射链，不能降低Three后宣称修复。纯Three兼容adapter三个显式profile仅作因果诊断，永不作为最终质量门。原r185为默认且逐字返回，材质hooks拒绝保持；scope仅Standard无纹理/扩展lobes、单方向灯、已有S4root。

Single-scatter只在实际RE_Direct调用选择既有BRDF_GGX；world-normal阶段将同样normalized normal变回world后计算同屏幕导数。最终边界从已有canonical库提取NDF与NV参数，不复制另一份完整BRDF；roughness policy取已有directDisplay canonical。所有Three替换块有精确源身份门，未知profile/源漂移/重复装配失败。

复用S4 probe，仅增加opt-in profile与曝光子集，默认原S4八矩阵不变。最终质量比较器只允许原three-r185 profile：全阶段保留HDR/surface有限、真实轮廓≤1px、稳定内部≥1000、实际灯光贡献≥1000；strict emissive与actual-direct均需HDR≤.002/byte≤2。Three单散射三个profile仅诊断，不构成质量修复或通过最终门；阈值不随结果改。

只做深色1920×1080两轮必要截图，数值仍320×192。GPU待根调度；不运行Cargo/WASM/sharedbuild。实际结果待验证。

## 已有能量实现与待接缺口

I-C12已有environment split-sum specularFraction/energyCompensation、同分数漫反射储备与白炉，不能重建。当前direct single-scatter没有使用已有brdfLut；新纯多散射核应复用该LUT与sampler，经正式shade/directDisplay消费，不加第二资源或宿主ABI。

S4原始HDR按发光签名分离六材质：高roughness纯金属两材质的Deep直射均值比Three低约8–9%，最大负差−.023404；混合金属斜视局部负差−.01624。该fixture支持缺失direct补能与normal空间差异；用户主视口整体偏亮还需真正近景复核，不能由上述统计推断已修复。

DFG合同不同：Three16²/4096样本且轴roughness/NV，Deep128²/256样本且轴NV/roughness；Deep积分使用separable Schlick几何项。直接复用既有LUT需要确认残差，不能预设与Three等价。原曝光/ACES固定，后继原Three对照与用户反馈优先。

## 生产接线与登记

新canonical `wgsl/brdfDirectMultiscattering.wgsl`只接收F0/两个DFG样本并计算直接补能，复用r185已有能量表达式；不会改变原brdfDirectLighting单散射函数、IOR/roughness或IBL白炉。根负责登记导出PBR_BRDF_DIRECT_MULTISCATTERING_WGSL、生成lighting mirror/sha与正式compiler/golden，不手改registry或生成mirror。

`pbrDirectMultiscatteringWgsl.ts`为宿主采样叶子，沿现有brdfLut/environmentSampler及NV/rough轴；无新LUT/绑定/ABI。正式HDR shade的view DFG只采一次并复用IBL，直接补能再采实际光DFG；directDisplay两正式路径调用同叶子。无实际primary光或NL≤0跳过direct采样。多灯forward-plus、Native direct消费属于后继，本刀暂不认证。

S4原始曝光/ACES、far镜头保留为控制组；用户要求的同材质灯光近景另冻profile，两个深色1920×1080截图。所有Three诊断adapter只归因，最终截图与门保持原r185；生产HDR/directDisplay源在根sync/集成GPU前冻结。


## 第二候选现状核查与冻结

全调用核查：正式HDR/透明/直接显示、四normal-map材质入口均消费同shade；normal-mapped路径此前把扰动法线作为几何导数输入。现保留orientedNormal作为geometryNormal，仅BRDF/反射/TBN使用mappedNormal；geometryNormal先worldToView，再消费已有canonical导数核。扩展lobes替换时同步扣除stock单散射与新补能，保留原扩展求值语义。实验visibility-buffer resolve无同frame矩阵/IBL ABI，本刀不改、不认证。

已有environmentShader brdfMain保持单LUT128²、每texel256样本，共4,194,304初始化迭代；把积分的separable Schlick改为已有canonical correlated Smith，与正式直射的分布/可见性合同一致。SSR CPU mirror消费同积分口径；Native ibl.rs独立LUT未改。本刀不增加资源、采样数或初始化dispatch。direct实际有光才读取light DFG，HDR view DFG与IBL复用。

首候选两真实轮原Three结果：far HDR max .014776（S4旧.023404）、display max2（旧6）；near max .027525、display2。严格emissive HDR .000293、display0、轮廓0保持。旧near scale.5底部盒体靠边，新镜头在复跑前固定scale.6（eye距离5.4），far原eye9不变。曝光固定.5、原r185 ACES；两轮8对，共近/远×front/oblique×strict/direct，每轮各自fresh realm。

近景高亮raw FP32对FP16误差含实际附件精度差：Three12.150934、Deep12.140625；最邻近half12.1484375对该FP32仍差.002497，原绝对.002门在此像素不可达。原raw门保持，未通过应报告，不能把CPU量化当GPU附件。若新增共同rgba16f GPU附件profile，须独立显式冻结与实际附件读取；本刀暂未增加此profile。


## 共同附件profile预注册（GPU复跑前）

根批准显式`shared-rgba16f`：Three使用真实HalfFloatType WebGLRenderTarget、Uint16 GPU读回后仅解码；Deep保持现有rgba16float。原raw FP32作为并列控制保存，默认S4附件不变。最终共同附件门HDR≤.002/display≤2、稳定内部≥1000、真实轮廓≤1px、实际直射贡献≥1000保持；未知profile或与实际附件类型不匹配不能通过。相机scale.6近景与scale1远景、原Three r185材质/曝光.5/ACES固定。passed只认证该显式共同附件范围，raw FP32单独记录原门结果，不把二者混写。


## 第二候选实测

2026-09-30两fresh轮、每轮近/远×raw/shared-half×strict/direct×front/oblique，共32个正式双后端帧对；Nvidia Lovelace。两轮完整像素与身份相同。实际结果记录在`test-output/interrupted-0930/c8-direct-material-chain/diagnostic.json`、`rounds.json`与两张dark1920×1080截图。runner返回1，passed=false，未生成evidence.json。

| 真实附件 | 近front HDR max | 近oblique HDR max | 远front HDR max | 远oblique HDR max | 全矩阵display max |
|---|---:|---:|---:|---:|---:|
| 原Three FP32 / Deep FP16 | .00525045 | .00413656 | .00154001 | .00313172 | 1 |
| 两端实际RGBA16F | .00390625 | .0078125 | .00146484 | .00292969 | 1 |

共同half严格emissive HDR/display全零；raw严格emissiveHDR .000293/display0。稳定内部4328–15987，真实直射贡献4568–16242，轮廓差全零。远景旧S4 HDR .023404降至.003132（最大误差降86.6%），display6→1。近景scale.6六对象留边，两轮截图可见高光宽度与色调接近原Three；完整Studio场景、Native、clustered direct、运行性能未认证。HDR .002门继续保留。

GPU白炉控制用既有`whiteFurnaceGpuTest.mjs`一次必要回归：背景/白球/SSRoff/SSRon四腿及SSR净差全部PASS；几何mean/max/p99和SSR toggle误差全零。证据`test-output/interrupted-0930/c8-s5-white-furnace/evidence.json`。CPU focused51 PASS/3旧Naga条件SKIP，Node比较器19 PASS，lab tsc PASS。

## 残差定位与LUT候选评估

保存附件CPU分析（不再占GPU）显示：共同half近front仅1/47961个稳定内部颜色lane超.002，近oblique6/41943；远front0/15081，远oblique2/12984。共同half p99分别.000244/.000366/.000488/.000488。近景最大像素是低roughness非金属球高亮，一至两half ULP；远斜视最大为roughness.9金属球。不能据此放宽门。

按正式fixture Raycaster近似恢复远斜视最差像素NV=.51986/NL=.97966/有效rough≈.96494，CPU double积分比较独立r185实际DFGLUTData：现128²×256与r18516²预计算表的direct MS红通道差约2.83e-7，改16²×4096约1.84e-6；两者都远小于实际.00313。近景最大像素的DFG补能差约1e-9。LUT不是这些最大残差的充分解释，后继应观察实际single/几何导数，不以grid调整代替因果。

16²×4096理论初始化迭代1,048,576，比现4,194,304少75%，LUT存储从128²×8B=128KiB降为16²×8B=2KiB；但会改变IBL/SSR的LUT离散语义，不能仅以迭代数宣称实际更快。CPU全512真实Three表通道比较max .014259/RMSE .001844，当前积分并非与该表逐值相同。证据`dfg-grid-analysis.mjs/.json`仅数值诊断，未作GPU验收或生产profile。

最小后继若有因果证据：复用createStudioEnvironment既有brdf texture准备、dispatch与environmentShader brdfMain；显式16-grid/4096-sample参数与CPU镜像，不加第二LUT。需锁studioEnvironment.ts（I-C15共有）、environmentShader.ts、SSR mirror/测试及参数合同，先保留128/256默认。当前不改生产候选。

## 截图范围评分

两轮均独立查看，设计令牌沿用base.css，对标原Three r185 Standard材质与Unity PBR的真实高光层次。十维：布局9、令牌9、排版9、交互状态N/A、动效N/A、3D局部材质9、信息9、反馈N/A、深色1080范围9、语义9。N/A是数值/视觉测试页不含相应产品流；该评分仅认证六材质共同输入近远景，完整UI/场景质量与严格HDR最终门仍未完成。用户新指令仅深色1080优先，未重跑浅色/窄屏。


生产装配覆盖plain、textured/normalmapped、透明与directDisplay调用；本轮像素fixture只认证Standard无纹理六材质。normal-map未扰动法线与扩展stock扣除通过聚焦合同/正式模块编译，未另跑normal-map/扩展lobe像素。一般HDR复用view DFG并增加有光light DFG一次；active扩展lobe保留既有stock求值后替换的策略，新stock扣除会重复DFG读取，实际性能尚未测，不能宣称极致性能验收完成。
