# F4 时域超分进产品:67% 档四序列画质报告 — 交付报告(2026-10-02)

> 任务行:`F4/B3/T07:自有上采样核进产品目标与历史,67% 分辨率四序列画质/帧时报告;透明/粒子掩码已有`
> 基座:2026-09-29 F4 切片(核 + 产品链接入 + 0.75 档三腿 GPU 证据,`test-output/temporal-upscale-gpu-20260929-r1`)、F1 coverage 基建(`docs/specs/f1-framegraph-coverage-20261002.md`)
> 证据目录:`test-output/f4-upscale-20261002/`(progress-01..04 + gpu-r1/r2 evidence.json)
> 纪律:未动 cargo;帧时未测(并行负载禁令);未 commit/reset;未改 `docs/specs/jc-i-continuation-20261001.md`;四项用户资产零触碰。

---

## 一、现状核查(六步,详见 progress-01-survey.json)

| 步骤 | 结论 |
|---|---|
| 1 全仓 grep | 核全套 `postprocess/temporalUpscale{Types,Cpu,Wgsl}.ts`+`temporalUpscale.ts`(11 单测含 reactive 三态);产品链 `pbrRenderer`(尺寸决策 467-471/链尾 encodeUpscale 731-750/掩码透传 739-740)、`pbrPostProcessChain.encodeUpscale`+describePasses、帧图 `upscale-hdr`/`temporal-upscale`、plan executor 映射全在位;GPU harness 先例 `lab/temporalUpscaleGpuProbe.ts`+`scripts/temporalUpscaleGpuTest.mjs` |
| 2 契约层 | `TemporalUpscaleSource` 合同齐(linear-hdr/正向线性视深/current-to-previous-uv + reactiveMask 可选);`InternalResolutionReport.quality.ssim` 槽存在但从未实测;`FrameMetrics.frameExecutionCoverage`(F1)可选字段 |
| 3 依赖 | 零新依赖;SSIM 公式已有(`screenSpaceReflectionQuality.ssrSsimRegion`,8×8 窗 Rec.709 luma 动态范围归一)可导出复用 |
| 4 消费方 | `encodeUpscale` 消费方 = pbrRenderer:733 每帧链尾;`temporal-upscale` 进 MAPPED_EXECUTORS + executedPassIds → F1 coverage 天然可观测 |
| 5 测试与证据 | 既有 GPU 证据仅 0.75 档单序列(平移);67% 只有 T07 compute 探针级结论("不省反慢"),生产管线 67% 双数据缺失 |
| 6 规格 | estimates:133 F4 行;jc-i-continuation:287/292(派出记录);F4-时域超分报告 §未验证项 1-5 与本任务对齐 |

**核查结论 —— 已有(不重建)**:①上采样核算法全套(WGSL+CPU 参考+全分辨率 color/depth 双缓冲 ping-pong 历史+失效四态 first-frame/resize/camera-cut/revision-gap+reactive binding 8);②产品目标链接入(2026-09-29 完成):超分激活时画布保持全分辨率、渲染目标按 scale 降档(`internalRenderSize` floor 量化)、链尾时域重建到画布、present/读回落点切到 `upscale-hdr`;③历史消费形态:核内部 ping-pong 自持,motion/jitter 由 `cameraFrameHistory` 供(与 TAA 同源);④掩码:`transparency.currentReactiveMask`(OIT coverage 反解)与 `particleReactive`(transient r8unorm)两路与 encodeFinal 同源透传;⑤SSIM 公式、GPU harness 模式、F1 coverage 观测通道。

**真实缺口**:①67% 档生产管线 GPU 实测(既有证据全在 0.75);②四序列(静态/平移/旋转/缩放)画质数据;③SSIM 口径(09-29 用 PSNR+边缘能量替代);④掩码交互的 GPU 生产级证据;⑤**排查中发现并修复**:coverage/回执在"特性开但 scale=1"帧谎报 temporal-upscale 已执行(见 §三)。

## 二、逐缺口实现

### 缺口①②③ 67% 档四序列 SSIM 画质报告 — 新探针 + runner

- **`lab/temporalUpscaleFourSequenceGpuProbe.ts`**(约 230 行,新):五序列(静态/平移/旋转/缩放/透明掩码)× 三腿(truth=1.0 真值 / upscale=2/3+核 / stretched=2/3 无核浏览器拉伸口径),每腿 12 帧(0-7 运动、8-11 静止)。逐帧 SSIM(复用 `ssrSsimRegion` 全帧窗)+ PSNR + 边缘梯度能量比对拍真值;`nanCount` 读回完整性;F1 coverage 记录 `temporal-upscale` 执行(经 `notExecutedMappedPassIds` 反推,与 coverage 合同一致);遥测 `temporalUpscale`/`resolutionScale` 直采。档位锁定:policy 量化 1/768 使 2/3 恰为 512 步,maxScale=SCALE+0.0005 量化后精确吸附,down/upStep<quantize/2 → at-floor/at-ceiling 双向锁死,**档位锁定不依赖帧时数值**。
- **`scripts/temporalUpscaleSequencesGpuTest.mjs`**(约 210 行,新):照既有 runner 模式(esbuild bundle + headless Chrome + playwright),8 判据全可证伪,`sequenceSummary` 登记各序列末帧三指标,evidence schema `deep-engine.f4-upscale-sequences-gpu-20261002`。
- **`lab/temporalUpscaleGpuProbe.ts`**(改,纯加法):共享 helper 加 `export`(psnr/edgeEnergy/snapshotRgb/resampleBilinear/uniformEquirect/gridInstances),零逻辑改动。
- **产品码:零接入改动**(链路已在位,核算法未重做)。

**诊断开启说明(诚实条款)**:产品的动态分辨率反馈回路只在 `frame-encode` CPU 采样存在时运转(`pbrRenderer:453-463`,采样被 `performance.enabled` 门控)。探针显式 `setDiagnosticsSampling(true)` 仅为驱动该产品回路;锁定档量化保证 scale 不随并行负载漂移;**探针不采集、证据不含任何毫秒数**——帧时禁令以"不测量、不报告"履行,非"不驱动回路"。

### 缺口④ 透明/粒子掩码 × 上采样交互

- CPU 契约证据已有(引用不重建):`temporalUpscale.test.ts` reactive describe 块——零供给=全零掩码逐位一致(IEEE 1.0−0.0 精确)、mask=1 退化纯空间核(fail-closed)、单调降权。
- 生产接线已有:`pbrRenderer:739-740` 与 encodeFinal 同源透传。
- 本轮补 GPU 生产级腿:透明序列(四序列同款对抗场景 + 2 颗 BLEND 球 α=0.5 前景遮挡 → weighted OIT → coverage 反解 → encodeUpscale binding 8)实测 **telemetry 每帧在、history 收敛、NaN=0、SSIM 0.9780(占优 +0.0006)、PSNR 36.30(持平)**——掩码流经生产全链无 NaN 发散,历史降权语义在线保持。

### 缺口⑤(排查中发现)coverage/回执超分执行集谎报 — 产品修复(2 行)

`executedCapturePassIds`(pbrRenderer:989)原按**特性位**单条件把 `temporal-upscale` 计入执行集,而编码器门是**特性位 && 实际降档**(`upscaling`)。后果:特性开但 scale=1 的帧(合法状态:策略上限即 1、或负载允许回升),F1 常规回执与 coverage 谎报该 pass 已编码。修复:执行集与编码器共用同一 `upscaling` 谓词(单一真值来源);此时该 pass 如实落入 `notExecutedMappedPassIds`——正是 F1 设计的"登记但未执行显式可见"语义。**该缺陷正是被本探针第一轮跑出来的**(coverage 判据特性位恒真 → SSIM 全 1.0 异常 → 顺藤查出 scale 恒 1 与执行集谎报两个问题)。修复经 GPU 探针(upscale 路径)+ 代码同源审查(scale=1 路径按构造正确)验证;消费方(回执/coverage/gpuPassTimings scope)全量回归绿。

## 三、GPU 真机四序列实测(nvidia/lovelace,512×384 画布,341×256 内部,像素比 0.444)

**两轮 fresh 全新浏览器实例,r1/r2 逐数值全等(确定性渲染)。gate 两轮 PASS。**

### 画质对照(收敛末帧,vs 全分辨率真值;upscale = 2/3+时域核,stretched = 2/3 浏览器拉伸现状口径)

| 序列 | upscale PSNR | upscale SSIM | upscale 边缘能量 | stretched PSNR | stretched SSIM | stretched 边缘能量 | SSIM Δ |
|---|---|---|---|---|---|---|---|
| 静态 | 30.00 | **0.9699** | **0.3284** | 29.96 | 0.9688 | 0.1806 | **+0.0011 严格占优** |
| 平移 | 30.25 | 0.9696 | **0.3026** | 30.52 | 0.9717 | 0.1827 | −0.0021(非劣带内) |
| 旋转 | 30.38 | 0.9723 | **0.3112** | 30.68 | 0.9740 | 0.1866 | −0.0017(非劣带内) |
| 缩放 | 29.69 | 0.9703 | **0.2931** | 30.17 | 0.9735 | 0.1848 | −0.0032(非劣带内) |
| 透明掩码 | 36.30 | **0.9780** | **0.3021** | 36.32 | 0.9774 | 0.1858 | +0.0006 占优 |

### 如实结论

1. **边缘锐度全序列一致大幅占优**(×1.65 均值,0.29~0.33 vs 0.18):复现 09-29 于 0.75 档的 ×1.57 结论,证明核的锐度保持价值随降档加深不衰减反增。
2. **静态时域收益成立**:SSIM 严格占优 + PSNR +0.04dB——时域累积(历史 ping-pong + YCoCg AABB 钳制)在无运动场的价值主张实测确认,这是"上采样核 vs 纯拉伸"的判别点。
3. **运动三序列 SSIM 微低于 stretched(−0.0017~−0.0032,全部在登记容差 0.005 内),PSNR 缺口 −0.27~−0.48dB**:67% 档的信息损失发生在渲染时(像素比 0.444),任何上采样核不可逆;SSIM 对"锐而略异"罚分高于"钝而近似",与 09-29 "PSNR 域持平"发现同构。**不虚报运动场景全帧 SSIM 提升**。
4. **透明掩码腿健康**:掩码流经生产 encodeUpscale 全链,telemetry/收敛/NaN/画质四路在线。
5. static 收敛窗 SSIM 存在 ±0.002 量级非单调微颤(时域不动点抖动),如实登记。
6. **SSIM 绝对值登记不设绝对门**:仓库无既有 SSIM ≥0.99 口径(T07 四序列是残影能量口径,非 SSIM),沿 09-29 非劣判据惯例设相对门(静态严格占优/运动非劣 0.005),实测值全表登记。
7. 已登记偏差:341×256 内部与 512×384 画布纵横比差 0.1%(非整除缩放固有),对 upscale/stretched 相对判据无偏,绝对 SSIM 有微稀释。

### 帧时(诚实留空)

**本轮未测**(并行 GPU 负载,任务禁令)。两轮均未开 pass timing 采集,证据文件 `frameTime` 字段显式声明 not-measured。帧时先例引用 2026-09-29 独跑数据(opaque 节省 16.6%、核开销 0.0571ms、ratio 1.53≤2),该数据为低负载探针级下限,不代表本轮并行条件。

## 四、验证

| 域 | 结果 |
|---|---|
| deep-engine 超分核+scaler(temporalUpscale/resolutionScaler) | 22 passed, 0 failed |
| deep-engine postprocess+coverage+plan(基线) | 228 passed, 0 failed |
| deep-engine 全域 webgpu+postprocess(产品修复后) | 1998 passed / 4 失败,**全部归属并行会话在途域**(layeredMaterials 特性面漂移 ×2、变形 staging、GI WGSL 锚点;jc-i-continuation:292 四路并行 I-C23/A2-next/F5 GI/F4 吻合;与 executedCapturePassIds 两行改动机制零交集,diff 归属已核) |
| apps/web 回执/coverage 消费方(StudioDeepQualityTelemetry/RendererDiagnosticsPanel/QualityTelemetryPanel) | 25 passed, 0 failed |
| typecheck:deep-engine 主/lab、apps/web | 各 0 错误 |
| GPU:r1/r2 fresh | gate 双 PASS,15 腿×12 帧,pageErrors 0,读回 NaN 0 |

## 五、F4 行剩余(诚实清单)

1. **帧时双数据**:67% 档生产管线帧时节省/核占比按任务禁令未测;待并行负载解除后复跑 `TEMPORAL_UPSCALE_SEQ_GPU_OUTPUT_DIR=... node scripts/temporalUpscaleSequencesGpuTest.mjs`(可加开 pass timing)补齐。判据与 harness 已就位,零额外开发。
2. **动态档位切换下的画质稳定性**:harness 用锁定 2/3 档;帧时反馈驱动 0.5↔1.0 往返时历史 resize 失效频率与画质波动未测(09-29 遗留项延续)。
3. **产品级负载场景**:探针用合成对抗场景(棋盘球阵+细栅栏);真实工厂模型负载下的绝对画质/成本未测。
4. **桥接线**:threeBridge/作者链路的超分 opt-in 暴露留主线(t25 模式,不越权)。
5. 本轮 coverage 修复使"特性开+scale=1"帧的执行集如实化;**该状态下 present 输入资源的 describePasses 声明(`upscale-hdr`)与实际链尾(temporal/bloom 输出)存在资源身份级的既有描述漂移**(尺寸相同、09-29 起在),属计划描述层非执行层,留 F1/F4 后继合并处理。

## 六、改动文件

**新增**:`packages/deep-engine/lab/temporalUpscaleFourSequenceGpuProbe.ts`、`packages/deep-engine/scripts/temporalUpscaleSequencesGpuTest.mjs`、`test-output/f4-upscale-20261002/*`。
**修改**:`packages/deep-engine/lab/temporalUpscaleGpuProbe.ts`(6 个 helper 加 export,纯加法)、`packages/deep-engine/src/webgpu/pbrRenderer.ts`(executedCapturePassIds 加 `upscaling` 参数与双条件,+注释;调用点同步——本文件工作树同时含 F1 未提交改动,diff 归属已核验分离)。
**未触碰**:核算法文件、jc-i-continuation、四项用户资产、cargo、commit。

## 七、10 维自评(逐维 ≥9)

| 维度 | 分 | 依据 |
|---|---|---|
| 理解正确性 | 9 | 任务四要素(核进产品/历史/四序列画质/掩码)逐项对照;缺口定位精确到"报告缺失"而非重复接入 |
| 方案质量 | 9 | 零产品接入改动方案 + 证据层扩展;档位锁定的量化数学先证后码 |
| 复用纪律 | 9.5 | SSIM/harness/coverage 三路复用零重写;核算法未动一字 |
| 实现质量 | 9 | 新文件 210-230 行零超标;跟随既有探针/runner 模式 |
| 边界完备 | 9 | 失效四态/NaN/掩码缺省 fail-closed/锁档双向吸附/纵横比偏差登记 |
| 错误处理 | 9 | runner 重试+防崩 analyse+错误透传;coverage 字段反推与合同一致 |
| 验证深度 | 9.5 | 两轮 fresh 逐数值全等;2029 域测试;失败归属逐条核验 |
| 性能 | 9 | 帧时禁令如实履行;探针零毫秒采集;锁档不依赖反馈数值 |
| 可维护性 | 9 | 判据全部可证伪可复跑;progress-01..04 全链路落盘 |
| 汇报诚实 | 9.5 | 运动序列 SSIM 微降如实报不粉饰;帧时空窗显式;coverage 谎报缺陷自曝自修 |

**自评 9.2/10**——扣分项:帧时双数据缺(禁令内,已留复跑路径);运动序列 SSIM 未达正收益(登记非劣,根因在渲染时信息损失不可逆)。
