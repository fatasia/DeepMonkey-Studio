# 最强抗锯齿方案(Anti-Aliasing Master Plan,2026-10-03)

> 目标:在 WebGPU/桌面双形态上建立**分层、可组合、自适应**的抗锯齿体系,默认档位即接近离线质量;与 three(MSAA4+SMAA)同构组合下像素对齐,并超出(时域+alpha-to-coverage+线 AA)。
> 全部自研/开源内置(SMAA/FXAA/CMAA2 均为宽松许可,固定版本内置);禁外部依赖。

## 0. 现状基座

| 资产 | 状态 |
|---|---|
| MSAA 挂点 | `PBR_MAIN_SAMPLE_COUNT=1`,管线 `multisample`/目标 `sampleCount` 已接——**只差常量与 resolve 通路** |
| 时域重建 | T07 自研 TSR(temporalAa 通路,残影 2.93% 口径)+ motion vector 管线已有 |
| 空间 AA | Deep 自有 spatialAa(边缘算法,parity aa-bloom 诊断档 RMSE 6.05 的 Deep 侧) |
| alpha-to-coverage | WebGPU `alphaToCoverageEnabled` 原生支持,**未使用** |
| 自适应质量 | AdaptiveQualityController(档位/预算/hotspot)已有 |
| 对照基准 | three=MSAA×4+SMAA;parity 门 aa-bloom 场景可定量 |

## 1. 分层体系(四层)

### L1 硬件层:MSAA + alpha-to-coverage
- **MSAA 4x 主目标**(sampleCount=4;检测 maxSampleCount 支持 8 时开放 8x 档):color+depth MSAA、resolve 进后处理链;透明/OIT/线性深度等附属目标保持 1x(逐一论证,不盲目全 4x)。
- **alpha-to-coverage**:植被/链栅/栅栏/particles 的 alpha test 几何开启 `alphaToCoverageEnabled`——MSAA 的免费质量放大器,对工业安全网/格栅类资产是质变。
- 验收:三角/圆边缘梯度能量 vs 1x 下降 ≥70%;a-to-c 资产对比图。

### L2 时域层:TSR(主)+ 防鬼影
- **TSR 默认参与组合**(T07 内核):低动态场景重建到原生以上分辨率,兼 AA;
- **防鬼影三件套**:运动矢量已备 + **几何置信度(disocclusion mask)强化**——深度不连续拒绝历史、相邻深度差阈值自适应 α;**透明/粒子不进时域历史**(独立分支,避免拖尾);
- 残影门:2.93% → **≤1%**(旋转/平移扫掠场景逐帧差)。
- 验收:旋转扫掠逐帧差 p99 ≤2/255;disocclusion 边缘无拉丝(对比图)。

### L3 空间层:SMAA(替换 spatialAa)+ CMAA2(轻量档)
- **SMAA T2x**(开源固定版本移植到 WGSL:边缘检测 LUT+定向模糊+邻域取整,内置):作为**空间兜底与混合成分**——MSAA resolve 后、或 TSR 输出后轻量补一遍(SMAA 对时域残余阶梯极有效);
- **CMAA2**(可选轻量档):低功耗/集显设备档(比 SMAA 更省,质量略低);
- 现 spatialAa 保留为 legacy 档(合同向后兼容),默认不选。
- 验收:SMAA 后阶梯残余(频域能量)较输入 ↓≥80%;CMAA2 档帧成本 ≤0.8ms@1080p。

### L4 内容特化层
- **线框/CAD 线 AA**:工业线框、轨迹线、轮廓描边(instanceOutline)——线渲染走 screen-space 平滑(四边形展开+距离场边)或依托 MSAA(线几何进 MSAA 主 pass);instanceOutline 已有半分辨率边缘,升全分辨率;
- **文本/overlay**:DOM overlay 天然抗锯齿(不动);画布内 label(sceneOverlayVisuals 的 CanvasTexture)绘制时自带 AA ✓;
- **alpha 测试资产**:见 L1 a-to-c;
- **粒子上屏**:粒子走 OIT/加法混合,不参与 MSAA resolve 锯齿(混合模式天然柔边);曲线 LUT 密度复核。

## 2. 组合档位(暴露给用户/自适应的最终档)

| 档 | 组合 | 目标设备 | 帧预算@1080p |
|---|---|---|---|
| off | 无(诊断用) | — | 0 |
| fxaa | FXAA | 极低功耗 | ≤0.4ms |
| smaa | SMAA | 低功耗(默认低档) | ≤0.8ms |
| msaa2 | MSAA 2x | 集显 | ≤1.2ms |
| **msaa4**(默认) | MSAA 4x | 主流独显/Apple | ≤2.0ms |
| msaa4+smaa | MSAA4 → SMAA 补 | 高质量 | ≤2.6ms |
| **tsr** | TSR(+MSAA1) | 超分/低分辨率比 | ≤2.5ms(含上采样) |
| **ultra** | MSAA4 + TSR + SMAA(sharpen) | 旗舰/展示 | ≤3.2ms |

- **默认档=msaa4**("默认效果就很好");`displayContract.antialias` 扩展 `{ mode, msaaSampleCount, smaa, tsr }`(缺字段=现行为,向后兼容);
- **自适应**:AdaptiveQuality 按 GPU 余量在 msaa4 ↔ msaa2 ↔ smaa 间降/升(复用既有 hotspot 机制),TSR 在动态分辨率激活时自动接管;
- manifest 登记 `antialiasing` 能力条目(双端支持档)。

## 3. 特殊场景纪律
- **透明/OIT**:加法/混合链不进 MSAA 主目标(1x + 混合柔边),避免 resolve 撕裂;
- **拾取/诊断读回**:读 present-color resolve 纹理(readback 路径同步改);
- **路径追踪/离线**:不适用 AA(自身是超采样)。

## 4. 实施批次

| 批 | 内容 | 验收门 |
|---|---|---|
| AA-M1 | MSAA4 通路(常量+resolve+readback+回退)+ 默认档切换 + 帧时证据 | 帧时 ≤+2ms;parity aa-bloom RMSE 6.05→<2 |
| AA-M2 | alpha-to-coverage + TSR 防鬼影强化(残影 ≤1%)+ SMAA 移植(T2x) | 组合档全通;阶梯能量 ↓≥80% |
| AA-M3 | CMAA2 档 + 线 AA 全分辨率 + 8x 检测档 + 自适应组合 + manifest/文档 | 全档位证据矩阵 |

### AA-M1 落地记录(2026-10-04)

**架构决策(与 §3 纪律的偏差与理由):**
- WebGPU 渲染 pass 强制全部附件同采样数,"MSAA 主 pass + 1x 附属 MRT(线性深度/
  view-normal/motion)"单 pass 内不成立。落地为:**主 pass 全附件 4x**(hdr + 三个
  MRT + 深度),颜色目标经 `resolveTarget` 硬件下采样到单采样主帧目标(后处理链/
  输出 bind group/读回/次级 pass 全部只消费 resolve 层,合同 sampleCount=1);
  MRT MSAA 附件仅 RENDER_ATTACHMENT 语义(TRANSIENT 驱动内存别名),内容只在
  pass 内经 resolve 消费 —— "附属目标默认 1x"在**消费层**成立。
- **深度无 resolveTarget(depth32float 不可 resolve、不可 storage 写)**:新增
  `pbrDepthResolve.ts`(depth-only 渲染 pass,`@builtin(frag_depth)` 直写 sample-0)。
  仅当主 pass 后仍有深度消费方(Hi-Z/透明 OIT/粒子/样条/作者网格/可见性/描边/
  display 背景)时编码;无消费方帧主 pass 直接 `depthStoreOp:"discard"`(任务口径)。
  sample-0 而非均值:保持深度数值语义(背景 depthCompare "equal"、Hi-Z 比较不变)。
- 直出 display 快路径(1x swapchain)不参与 MSAA;display/directional/阴影管线恒 1x。
- 能力回退:bootstrap 前 `probePbrMainSampleCount` error-scope 探针(同 activateHdrCanvas
  先例)探测 rgba16float+depth32float 4x;失败 fail-closed 回 1x(整渲染器 1x 构建,
  逐字节旧行为),原因经 `FrameMetrics.msaa.fallbackReason` 披露。
- `PBR_MAIN_SAMPLE_COUNT=4` 语义改为"请求默认档";`PbrRendererOptions.msaaSampleCount`
  (1|4)与 `displayContract.antialias.msaaSampleCount?`(缺字段=4,向后兼容)双入口。

**改动文件:** packages/deep-engine/src/webgpu/{renderTargets,pipelines,pbrPipelineSet,
pbrBackgroundPass,pbrMainBindings,pbrOpaquePass,pbrFramePlanResources,pbrPostProcessChain,
pbrFramePlanExecutor,pbrRenderer,pbrRendererBootstrap,pbrRendererFrames,pbrRendererTypes,
clusterLodRenderSlot,clusterLodSlotSupport}.ts、新增 {pbrMsaaCapability,pbrDepthResolve}.ts(+测试)、
lab/msaaPerfProbe.ts、scripts/bench-msaa1080p.mjs、packages/contracts/src/displayContract.ts。

**证据(2026-10-04,RTX 4060 / Chrome headless WebGPU):**
- 帧时门:1080p 生产默认特性档(MRT+AO/TAA/HiZ/SSR/体积雾),MSAA4 vs 1x 各 240 帧、
  逐帧 submit 背压。GPU 时间戳口径(gpu-frame):p50 1.835→2.294ms、p95 1.901→2.359ms,
  **增量 +0.459ms(p50/p95 相同)≤ 2ms 预算,passed**;submit-done 墙钟口径同向
  (4.3→5.0 / 5.7→6.6)。证据:test-output/msaa-perf/evidence.json(scripts/bench-msaa1080p.mjs)。
- parity 门:全部 8 场景 passed、stable;**pbr-matrix 0.258 / directional-shadow 0.092 /
  bloom-only 0.183 严格档逐位保持**;aa-bloom 6.05→**3.844**,SSIM .9917→.9964,
  over8 1.88%→0.85%,档位 diagnostic→**tolerant(ratchet 已锁)**;其余场景逐字节不变
  (探针按场景镜像 three 侧 MSAA 配置)。aa-bloom 残差 = three 侧 SMAA(Deep 侧移植在 M2)。
  证据:test-output/parity-gate/evidence.json(基线刷新与原因见 parityGateThresholds.mjs aa-bloom 注)。
- FrameMetrics.msaa 遥测:4x 渲染器 `{requested:4, active:4}`;回退帧携带 fallbackReason。

### AA-M2 落地记录一:TSR 防鬼影决策层接线进生产 WGSL(2026-10-04)

**接线内容:** T07 残影修复的 `GHOST_GUARD_REPROJECTION_POLICY` 决策层(深度拒绝
disocclusion → 3×3 box fallback;深度匹配内容变化 → clamp 残差超线 feedback ×0.1
衰减)从单测/注入体接线进生产 `temporalAa`/`temporalUpscale` 两核的历史融合段。
开关载体 = **WGSL 编译期常量** `DEEP_TEMPORAL_GHOST_GUARD`(contactShadow steps
编译进 WGSL 同族先例,features 表外):默认 0 = 关,基线分支逐字保留历史生产语句
→ 输出与旧 WGSL **逐位一致**;开启经 `enableTemporalGhostGuardWgsl`(单字符翻转,
fail-fast)+ pass 构造选项 `TemporalAaPass/TemporalUpscalePass(…, { ghostGuard: true })`,
不动 features 表与 pbrPostProcessChain。决策层 WGSL 片段与常量唯一来源在
`temporalReprojection.ts`(deriveTemporalGhostGuardWgsl 由策略对象模板化)——T07
GPU 探针同步改为翻生产常量,注入式退役。两个核纳入 `wgsl:sync` 单源家族
(wgsl/temporalAa.wgsl、wgsl/temporalUpscale.wgsl 真源 + 生成镜像 + sha256 +
temporalAaWgslChecksum / temporalUpscaleWgslChecksum 门禁:镜像不陈旧、策略字面量
与 GHOST_GUARD_REPROJECTION_POLICY 互钉、决策关键行锁定、失效门位置锁定)。

**证据(2026-10-04,RTX 4060 / Chrome headless WebGPU):**
- 逐位一致门:git HEAD 历史 WGSL vs 新 WGSL(开关关)真机 GPU 逐字节对拍,TAA 四
  序列(fence/thin-tube/rotating-blades/moving-character)与上采样核(合成栅栏+深度
  跳变输入)全部 byte-identical;开关开为同一 WGSL 单字符翻转且全场景确实分流
  (maxDiff 0.39–0.91)。证据:test-output/deep-core/T07/ghost-guard-wiring-probe/
  evidence.json(scripts/t07TemporalGhostGuardWiringProbe.mts)。
- 残影门:CPU 镜像 frame-3 = 0.6834%(门 ≤1%,与接线前一致不回退);T07 全链路
  GPU 复测 allPass=true(生产 WGSL 常量翻转路径)。证据:
  docs/reports/deep-core/assets/t07-temporal-sequences-gpu-2026-09-28.json(重采集)。
- Naga 30.0.1:两真源 ×(关/开)四变体全部 validation successful。
- 测试:deep-engine src 全套 vitest 绿(postprocess 29 文件 225 用例,含 12 条新门禁
  用例);tsc 对本刀文件零错误(仓库在途 dgcLoader.ts 未跟踪文件有既有错误,非本刀)。

**同族排查:** 决策层只活在可信历史分支内——camera-cut/resize/revision-gap/首帧仍走
宿主 fail-closed(sizeHistory.z=0 / flags.x=0 整支跳过,输出退化纯空间核);
temporalValidity.ts 独立门未动;reactive 降权次序保持「(1-reactive) 先于 decay」;
depth 拒绝判据(threshold = max(绝对,相对))原样保留,box fallback 只在其后分流;
MV 管线未动(t07 mvMaxErr ≤6.2e-5)。

## 5. 指标体系(进 verify 与 parity)
1. **parity aa-bloom**:目标 RMSE <1(与 three 同构 MSAA4+SMAA 组合后);
2. **边缘质量**:边缘带像素梯度能量 vs 4x 超采样参考(离线路径追踪或 2x 分辨率渲染);
3. **时域稳定**:扫掠场景逐帧差 p99、残影百分比(T07 口径);
4. **帧预算**:各档实测(上表);
5. 全部门进 `verify:gpu-release` 与 QA 截图(1080p 深色)。
