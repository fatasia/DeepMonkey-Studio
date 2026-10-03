# F5 最终 WebGPU 验收 — 2026-10-02

> **最终裁定：F5 行保持开放，不放门。** 原三域比值退化、12 项矩阵 11/12、产品 Chebyshev 不可消费、动态严格恢复非逐位，均如实保留。上批镜面亮度比归因错误，已撤生产乘子，不用变暗或负比值冒充正确遮挡。
> 新证据根：`D:/Documents/bim/bim-studio/test-output/f5-final-webgpu-verification-20261002/`。
> engineering-taste / testing-taste / design-taste-digitaltwin 已加载。禁 cargo、帧时未测、Native 未认证；root 账本只读；未 commit/push/reset/clean/stash。

## 1. 现状核查（执行前，六步）

1. 全仓检索（含未跟踪）：`intFloorBack` 是室内地面后段矩形 `[700,780,1300,980]`，不是取整。上批镜面乘子与 TS 函数/测试存在且未做产品像素验收。
2. 契约：读 contracts、probe 类型、Frame ABI、texture/storage 采样 ABI。产品 `deepGiSampleTexture` 只读 rgba16float、metadata；无 meanDistance/variance。storage 的 96B record 有 moments，不能据此声称产品纹理消费。
3. 依赖：pnpm、vitest、esbuild、tsx、playwright-core、sharp、Chrome/naga 都已有，零新增依赖。
4. 消费方：`shade`、reflection radiance、clipmap texture/storage sampler、capture producer、Studio bridge、站位光投影均定位。
5. 证据：GI visual / fix / L4 / L4-next 各两轮 state、metrics、全部 runner/entry、diagnostics、progress；原 8/16/32 方向矩阵与门常量均读。L4-next progress01/02 已证产品两 GI 态同一全量管线，差分真载体是半球站位光。
6. 规格：上批 variant semantics、L4 root cause、GI visual、32dir 历史报告、root `jc-i-continuation-20261001.md`、恢复账本只读。仓根 `AGENTS.md` 实际不存在（Read 精确返回 File does not exist），上级/用户指令照常生效。

**已有（不重建）**：原 fixture、冻结机位/三域/1920×1080、原产品 runner 和捕获泵、站位光排除修复、方向矩阵/真实纹理 consumer。

**真实缺口**：未认证的镜面乘子；负 ratio 掩盖无开门信号；texture 无距离通道；捕获主光遮挡已变化而冻结参考未对齐；四历史失败仍存在。

旧证据只读，`input-manifest.json` 记录 L4-next 全部 TS/MJS/JSON SHA-256，收尾复核 `oldAssetHashChanges=[]`。本批源码不碰站位光、layered、packet、capability、contracts 或 Native 文件。

## 2. 物理审查与必要修复

### 2.1 撤销上批不成立的归因

上批称 GI-off 直显无 IBL、GI-on 全量新增镜面 IBL，因而将其归为 leakRatio 主体。这与实际产品不符：

- Studio features 含 environment/SSR/volumetricFog，`writeGeometry=true`，直显集根本不建。
- 六轮产品 receipt 中两 GI 态 `hasForwardMain=true / hasDirectDisplay=false / hasDirectDirectional=false`。
- GI 关闭替换的是探针绑定，**不是同产品里移除镜面 IBL**。
- 已落盘 L4-next 的站位光排除修复保持不动；撤候选后冻结外景/A/B/GI-off 与 L4-next 相同，是归因纠错的独立真实证据。

历史规格及 root 账本不回写，错误原文原样保存；本规格给出更正。

### 2.2 亮度比不是镜面可见性合同

`clamp(L(probe)/L(environmentIrradiance),0,1)` 缺少方向/几何可见性证据：

- capture 的 RGB 是**全球方向的首次命中 Lambert 辐射 + ambient miss 均值**（kernel:299-343），不是接收面法线半球 irradiance，更不是反射方向可见性。
- 暗 albedo×无遮挡与白 albedo×遮挡可产生相同 RGB/alpha，函数无法区分，镜面不能随漫反射颜色被抹掉。
- local reflection 有独立纹理/捕获来源；不能由 diffuse probe 暗值清除合法局部镜面。
- texture 单层 alpha 为 0/1，但 `deepGiSampleTexture` 最后 `mix(fine,coarse,blend)` 会产生 **fractional alpha**。候选 `a>0` 全门控与原 diffuse fallback 不一致。
- 环境亮度跨 `1e-4` 阈值时，黑 probe 的乘子从 1 跳到 0，不具缩放不变性；diffuse 近黑不能证明 reflected/local radiance 无能量。
- 原算术对 NaN probe 可输出 NaN；不将其修成另一个遮挡启发式，直接取消生产消费。

### 2.3 最小修复面

| 文件（绝对根 D:/Documents/bim/bim-studio/） | 本批改动 |
|---|---|
| `packages/deep-engine/src/webgpu/pbrShader.ts` | 删除上批 `deepGiSpecularEnvironmentVisibility` 和镜面乘子；恢复 `radiance * specularFraction * occlusion * frame.eye.w`；保留其他已有 hunk（如 normalInput），不改 diffuse mix/C12/局部反射/直接光 |
| `packages/deep-engine/src/lighting/probeSpecularEnvironmentVisibility.ts` | 原算术保留为 deprecated、仅反例诊断，不再宣称物理 visibility，不挂公共 barrel；无生产调用 |
| `packages/deep-engine/src/lighting/probeSpecularEnvironmentVisibility.test.ts` | 七组反例：算术保全、暗色/遮挡不可辨识、近黑阈值、fractional alpha、非有限输入、local reflection、生产无乘子合同 |

修复前源码单独留 `pre-correction-*`，候选两轮不覆盖。没有新公共合同/新依赖/Native 改动，没有做全家族 wgsl:sync。

## 3. 实际运行与证据真实性

- 复用 L4-next runner/entry，拷到本批独立 ignored 目录；只增加输出分代、adapter/实际 backend/源哈希、A 态同包 GI-off 辅助对照。旧 runner 不修改。
- **六轮产品完整运行**：candidate 两轮；corrected 扩展诊断两轮；corrected-frozen 原冻结序列两轮。每轮 thinwall+dynamic 独立 Chrome session，所有 fixture/机位/三域不变。
- Chrome `154.0.8037.93`；adapter `vendor=nvidia / architecture=lovelace`，不是 SwiftShader。本结论限该硬件/源，不扩大到所有设备。
- 每轮源码 `sourcesBefore==sourcesAfter`；所有捕获最终 drain，sealed 240 tick 后 287 更新/36 批、141 有效 texel；包替换/恢复/动态 revision 都进位；没有 harness 补位 resync。
- candidate bundle `cd8b94730810eb755678cf35eaf4b5c6438cd21aebcd3a618f84c1a0efdfe0d6`，撤乘子扩展诊断 `1c4eb0c448c007a33e57107af5fef97c0977197b9e80838d4c756c514b16f269`；冻结轮的独立 bundle 在各 `state.json`，不得拿先前 bundle 冒充当前。
- 各轮 pageErrors=[]；数值 GPU queue/shader errors=[]。产品 runner 服务器 favicon 未提供，每页一条 404 已原样留日志（harness 资源，**不是控制台零错误**）。
- 官方 browser-use 在子线程精确失败 `Browser is not available in subagent`，故复用落盘产品 Playwright runner；截图直接 Read 审阅。没有假称浏览器工具可用或静默换 provider/model。
- 124 张完整主/步进截图、246 张动态 screencast（每轮41），均保留原分辨率。18 张无裁切 contact-sheet 逐张 Read，包括全部流帧；另 Read frozen sealed/A/外景原分辨率。原图 SHA 每轮 receipt 有记录。

## 4. 冻结门实际结果（不挑点、不改门）

### 4.1 三域 sealed 原门：不可认证，不放门

冻结公式 `round2decimal(sealedDelta.R)/max(round2decimal(openDelta.R),0.01)`、门 `≤1.05`，原三个矩形全部执行。

| 域 | candidate（两轮同）open RGB / sealed RGB / ratio | corrected-frozen round1 | corrected-frozen round2 |
|---|---|---|---|
| intFloorBack | [-0.07,-0.06,-0.07] / [-0.96,-2.30,-3.40] / **-96** | open [-0.07,-0.06,-0.07]; sealed [-0.87,-2.04,-3.01]; **-87** | sealed [-0.85,-2.02,-3.00]; **-85** |
| intBackWall | [-0.30,-0.60,-0.78] / [-3.70,-6.44,-8.19] / **-370** | open [-0.27,-0.55,-0.72]; sealed [-3.35,-5.81,-7.24]; **-335** | sealed [-3.34,-5.79,-7.23]; **-334** |
| intPartition | [0.02,0.02,0.03] / [-0.13,-0.99,-1.58] / **-6.5** | open [0.02,0.02,0.03]; sealed [-0.09,-0.96,-1.43]; **-4.5** | 同 round1 |

**负数算术满足 ≤1.05 不等于过门**：前两域 denominator 被 0.01 地板替换；第三域 open R 仅0.02、两位舍入已影响比值。GI 增量正控制基本不在场，不能以 sealed 变暗或站位光删除关门。

另存不舍入全域统计而不替换原尺：corrected 扩展同态三域 sealed signed R 为 -0.8735/-3.3544/-0.08306，positive-only R 平均仍0.0652/0.1241/0.00543；局部最大 RGB 差53..72。**负区域平均并不证明所有像素无正增量**。`full-image-audit.json` 全通道/逐像素留证。

### 4.2 GI-off 不变性：原冻结双轮全部逐像素相同

原冻结序列的外景/室内open/室内sealed/动态B共四张 GI-off，在两轮对 **L4 round2 与 L4-next round2** 都 raw RGB 恒等、MAE=0。候选与撤乘子同诊断路径的五张 GI-off（另含动态A）也恒等。

**实验设计纠错**：初版扩展 runner 多采同态A-off后又 `stillConverge`，多加一次0.004相机微移；动态B与历史 MAE≈0.000599 不能归为产品回归。该批原证据保留，不删；增加 `corrected-frozen` 完整原序列两轮才核销历史不变性。没有改机位去追绿色读数。

### 4.3 动态腿：更新到B正常，严格恢复/物理能量仍不足以全过

- 原冻结 A patch `[206.11,198.98,190.19]` → B `[196.12,188.71,178.90]`，两轮一致，包提交后首变化流帧分别 +325/+329ms；全41帧均分析，视觉未见旧A遮挡残影。
- 八步/41流帧的误差不是严格单调（相机步进/时域历史参与），不重新声称“单调无扰动”。
- 重发布A：round1 `[206.33,199.27,190.56]`、round2 `[206.08,199.06,190.38]`；对本轮A全帧 MAE **0.00318/0.00326**，局部最大RGB差可至123。若沿底座“≤0.15/255 patch恢复”原严口径，round1 最大通道0.37、round2 0.19均未满足；不能说逐位可逆。
- 对 L4-next 的A/B/八步稳定结果多为raw恒等，重发布在round1有时域漂移；`frozen-image-audit.json` 所有比较均保留。
- 同包A-off/B-off分解（扩展诊断，不替换冻结门）：A GI delta `[+0.50365,-0.02634,-0.52898]`，B `[+0.63151,-0.13877,-0.54267]`。A→B绝对变暗主要含直接遮挡变化，**不能把绝对patch R−B或跨包A-on减B-off叫“红反弹”**；同态GI红蓝差虽为+1.033/+1.174，R增量并不随遮挡衰减。正色证据不等于全部动态物理门通过。

### 4.4 室外腿：修复不新增回归；不重定基线掩盖历史差

- corrected-frozen外景GI-on两轮对L4-next逐像素恒等、MAE=0；GI-off对L4与L5都恒等。
- 对L4含站位光旧帧，GI-on MAE **0.0510689**，必须并列报告，不能称所有历史室外无差。
- candidate比L5额外暗化MAE0.0001496、176619像素变化、最大差15；撤镜面乘子消除这一非物理额外变化。
- toggle restore MAE约0.001530、最终camera restore约0.00106；大局部差主要在几何/时域边缘，不能用均值淡化“非逐位”边界。

## 5. Chebyshev 可消费门与原矩阵

### 5.1 原12项8/16/32矩阵：双轮11/12，失败不跳过

复用原 `f5ProbeLeakDirectionMatrix.mts` 与prep/field/storage/texture consumer；禁用warmup/samples计时（0/0）、不跑收敛计时段；原12 checks未删、原门未改。

- 三档污染policy均 `0.000213623`（门≤0.005）、漏光率0.11226%；preFix0.062286/0.058224/0.062697，压缩291.57/272.55/293.49×；背墙差0。
- 埋入alpha8个全0、validCount62；texture rejected误差均0.000213623；storage GPU/CPU最大差3.33786e-8；overflow/queue/shader均0。
- **失败项**：`rmseContextMatchesSequence=false`，8/16/32原参考RMSE **96.18% / 96.64% / 94.67%**；原32≤10%不达门，8→16也不单调；both rounds allPass=false、脚本 exit1。
- 脚本进程组合最后 printf exit0不代表门过；receipt清楚登记round1_exit=1/round2_exit=1。

### 5.2 为什么RMSE失败：不能仅说旧参考漂移便豁免

`capture-reference-semantic-audit.json`只读已捕获字段，沿原62点domain/4096样本seed20260927：

| 档 | 冻结unshadowed参考 | shadowed MC诊断（不升格） | 同方向shadowed CPU参考 |
|---|---:|---:|---:|
| 8 | 96.18% | 166.23% | 0.1190% |
| 16 | 96.64% | 104.20% | 0.1009% |
| 32 | 94.67% | **55.89%** | 0.0805% |

生产已补命中点shadow射线，旧prep的MC/parity默认unshadowed，导致原口径失配；但即便诊断同物理shadowed参考，32方向误差仍55.89%，**不是“换参考就绿”**。32方向稀疏采样遇遮挡不连续仍有质量缺口。本批不改旧reference与原门，不取消阴影或加亮度补偿追数据。

### 5.3 产品是否真实消费距离：全16点双轮实证为否

`chebyshev-moment-consumption-round{1,2}.json` 用原完整16接收点，固定 RGB/validity，只改变亮探针distance/variance/miss限定符：

- storage `deepGiSample` 最大变化 **3.7028297**，对CPU最大误差 **9.53674e-7**。
- 产品 `deepGiSampleTexture` 最大变化 **0**，ABI根本没有moment槽；因此 **productChebyshevConsumable=false**，并非过门。
- 首版把同半球亮列全乘同样权重，归一化抵消，仅见f32误差；保留 `first-degenerate-*`，不拿它当验证。v2在同接收域布置亮暗邻居后确认storage灵敏度、texture不可消费，旧证据全部保留。

不能用storage注入测试代替产品消费，更不能再用亮度比当遮挡替代品。完成该缺口需要真实捕获moments与texture binding/采样链的独立改造；本批“不新增公共合同/不碰他线”，只登记精确方案，不擅自扩ABI。

## 6. 历史四失败的当前精确定位（非“并行在途”豁免）

全部先单独精跑，再按environment/reflection、deformed/layered/array、staging/resident、capability/HLOD家族复跑，最后完整351文件复跑。它们**当前真实失败**，本批不越线修复。

| 文件 | 精确机制 | 同族实测 |
|---|---|---|
| `pbrEnvironmentIntensity.test.ts:55-56` | 字符串断言还要求inline `reflection, rough * maxSpecularLod).rgb * ...`；当前shader通过 `deepPbrReflectionRadiance` helper/LOD rebasing，旧串不存在。需按实际helper contract更新测试，不叫生产强度错误或泛称并行 | intensity14其余过；environment/reflection/prefiltered邻居全过；该1case仍败 |
| `pbrUnitNormalContract.test.ts:27` → `pbrLayeredMaterialShader.ts:83` | **上批“HEAD行不符”归因错误**。plain源码锚点实际1次；`deformedSceneShader=sceneShader+PBR_DEFORMATION_VERTEX_WGSL`追加同型tangent行后出现2次，`replaceOnce`要求恰1导致deformation+layered组合导入失败；另一normal锚点也需组合审查 | plain layered6case、deformation3case过；组合suite失败（不是两个case可忽略） |
| `packetDeformationUnsupported.test.ts:9` → `packetBufferStaging.ts:68-69` | `admitPacketVertexStreaming(context,prepared)`在deformation fail-fast前访问传入undefined context，抛 `reading vertexStreamingGeometry`，不再命中“not enabled”期望。属于guard顺序/fixture合同问题 | staging deformation7、resident staging9、resident projection10过；该1case仍败 |
| `hlodProxyDrawBatch.test.ts` → `rendererCapabilitySelfCheck.ts:291-311` | DEFAULT features多`layeredMaterials`，自检observed未恰好覆盖；模块import直接throw，阻断HLOD测试。需要同步selfcheck/manifest，但本批禁公共合同扩展 | selfcheck缺项精确读源码，HLOD suite未执行，不报HLOD正确性通过 |

`historical-family-current.json`、`focused-current.json`、`full-family-current.json` 全部原始失败保留。

## 7. 测试/类型/Native边界

- 本线6文件 **60/60 passed，0 skip**，含7反例、shader22、sampling13、texture2、checksum3、matrix13；naga解析/语义门真实执行。
- 全lighting/rayTracing/threeBridge/webgpu+匹配lab：**2915 passed / 2 failed cases + 2 failed import suites（4 failed files/351）**，不说“全绿”。
- Studio environment/projection/bridge邻居 **35/35绿**。
- deep-engine src/lab/examples三个typecheck本批真实exit0（上一批examples失败已不在当前树，不能沿旧归因）。
- 本线diff check通过；没有public导出。无新GPU计时/帧时结果。
- Native/Rust：本批未改、未编译、未cargo测试。`probe_gi_grid.rs`已有L3收紧的CPU公式（只读核查），与Native实际GPU消费/记录producer是否同步**未认证**。上批亮度比**从未Native同步且本批已否决，不能再移交为必须镜像的物理合同**。Web纹理缺moments仍与Native storage途径不等价。
- GPU窗口完成后已明确通知root交C2；后续只有CPU审计/落盘，不抢验收窗口。不另派、不换模型，未遇1308。

## 8. 七轴覆盖与自评（如实不降门）

七轴：主路径=三域/开关/换包完整；边界=阈值/alpha/暗色/local/NaN≥4反例；失败=四历史家族+矩阵门失败+browser不可用均实测；并发重复=源哈希前后、GI重开、预算2/16、两fresh；恢复=sealed→open/A→B→A与历史原序列复验；权限=内部本地GPU fixture无auth，N/A不是已测角色；呈现=原1920暗主题所有主图/流帧，未测试手机/亮主题（该冻结fixture不属于响应式UI交付）。

对标Unity PBR物理一致性/西门子可追溯标准，使用既有base.css，未做设计令牌改动。18contact sheets全部Read+3原图，原图370张在目录，不挑点。

| 表 | 逐维评分 | 裁定 |
|---|---|---|
| 工程10维（理解/方案/复用/实现/边界/错误处理/验证/性能/维护/诚实） | 9/9/10/9/9/9/**8**/9/9/10 | 验证仍有真实失败，未达整项交付门；性能仅确认撤乘子减少热路工作，帧时未测 |
| 测试8维（覆盖/真实/缺陷/家族/证据/分级/边界/修复回归） | 9/10/10/9/10/9/10/**8** | 本线撤错误乘子已修；F5整体部分修复、冻结门与同族未闭 |
| 视觉10维（构图/令牌/排版/状态/动效/3D/信息/反馈/响应主题/语义） | 9/9/9/9/9/**5**/9/9/N.A./9 | 3D物理门不足；响应主题未验，不冒称95%视觉合格 |

## 9. 最终receipt与下一可执行动作

总收据 `test-output/f5-final-webgpu-verification-20261002/final-receipt.json`：`certified=false / F5RowClosed=false`，六fresh源哈希稳定，`oldAssetHashChanges=[] / shotHashMismatches=[]`，370张产品PNG全部核验，GPU窗口已交C2。它不是闭门凭证。

1. `frozen-image-audit.json`：原双轮全部20张主/步进图比较+全部82流帧统计。
2. `full-image-audit.json`：候选/修复扩展两态全域signed/positive/max/MAE、同态GI分解、全部164流帧。
3. `chebyshev/round{1,2}/evidence.json`：原12门和失败allPass=false；raw consumer另存。
4. `chebyshev-moment-consumption-round{1,2}.json`：完整16点真实消费门false。
5. `capture-reference-semantic-audit.json`：原门失配与shadowed诊断仍失败，gatePromoted=false。
6. `f5-owned-green.json`、三typecheck日志、完整/历史家族失败JSON、input manifest、source snapshots、contact sheets。

下一刀应先补真实captured moments→产品消费并钉producer/storage/texture一致性；对现捕获shadow语义重新设计**可识别正控制**与明确物理参考，再按root批准保留旧门并追加新门（禁止本刀偷偷换尺）；同步解决动态恢复的camera/时域公平对照，四失败交归属线修正。本批不实施新公共合同，F5不关行。
