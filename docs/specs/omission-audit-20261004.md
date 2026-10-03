# 全仓遗漏任务整体排查报告（2026-10-04）

> 排查范围：61 行表（58/61 登记关闭 + 3 行 GPU 窗口批）之外的遗漏任务。
> 方法：六路并查（历史尾项 / 规格余项 / 代码 TODO / 测试跳过 / 拍板窗口项 / 对标覆盖），
> 只读审计，全部结论给出处（文件:行 或 代码 grep 实证），无臆测。
> 基线：`61-row-final-status-20261004.md`（58/61=95.1%）、账本 `jc-i-continuation-20261001.md`（追加一~一百零二）、
> 机器账 `test-output/progress-audit-20261002/61-row-status.json`（closed=58, open=3）。

## 0. 排查方法与现状核查

| 路 | 手段 | 关键结果 |
|---|---|---|
| 1 历史尾项 | 通读账本 102 条追加 + 9 份 scope-lock + 2 份 t-audit + t22-bounded + 抽验 6 处代码现状 | 23 个核查行全部登记关闭；但 t-audit 拆出的实现级新任务行**从未进入执行表**（见 §2.1） |
| 2 规格余项 | grep specs 全域"待做/余项/待办/留小批/专批/条件触发/拍板" + 逐份读登记小节 | 汇总 26 项（见 §2.2/§2.3） |
| 3 代码 TODO | grep `packages/*/src apps/*/src` 的 TODO/FIXME/HACK/XXX（ts/tsx/rs/wgsl） | **零命中**；Rust `#[ignore]` 为 GPU 测试 crate 惯例（显式 --ignored），非债务 |
| 4 测试跳过 | grep skip/todo/`#[ignore]` + n5 规格运行统计 | 无条件 skip/todo 零；全部为环境门控 skipIf + GPU 惯例（见 §2.5） |
| 5 拍板/窗口 | 账本提取 + 61-row-status.json note 字段 + 系统诊断记录 | 3 行内 GPU 批 + 4 项拍板挂起 + 9 项窗口/环境挂起（见 §3） |
| 6 对标覆盖 | optimization-phase-plan 六批次 × deep-engine-gap-vs-unity-ue 49 项缺口矩阵逐项对照 | 8 项工业关键缺口中 2 项无行承接（见 §2.6） |

代码现状抽验以 2026-10-04 工作树为准（本机 `git status` 800 条在库产出与账本记录一致）。

---

## 1. 总体结论

61 行表**行内**确实只剩 3 个 GPU 窗口批，账本记录可信。但存在一整块**系统性遗漏**：
10-01 两份深度审计（`t-audit-batch1/batch2-20261001.md`）从历史 T00–T32 尾项中拆出 **32 条实现级新任务行**
（batch1 19 条 71–142h + batch2 各组新拆行），明确建议"按优先级插入执行表"，
**61 行表与后续 scope-lock 批量关闭均未承接**；其中 T14/T20 两组的批量关闭判定与今日代码现状直接矛盾
（同 T12/N5 误判同族）。另有规格级登记缺口 26 项散落各规格"余项"小节，无任何排程记录。

---

## 2. 六路并查明细

### 2.1 路线一：历史尾项 T00–T32 核查状态

**核查行层面（全部 [行内已闭]）**：T 核查/范围锁定累计 23 行收口
（`t13-scope-lock-20261002.md:13`："T00-T32+N5 全部收口，实现覆盖/精确余项/条件触发三态明示"）。
逐行出处：T00（t00-scope-lock）、T08/T09（t08-t09-scope-lock）、T12（t12-scope-lock，含 02:30 更正）、
T13（条件触发）、T14/15/16/19/20/21（t14-21-batch-scope-lock）、T17（t17-scope-lock）、
T22（t22-bounded-acceptance，有界验收）、T23/T28（t23/t28-scope-lock）、T24（t24-scope-lock+后续五批）、
T27/T29/T30/T31/T32（各 scope-lock）、N5（账本追加七十八，实测纠正错误关闭后重闭）。

**实现行层面（[行外遗漏]，本报告最大发现）**：

#### A. t-audit-batch1-20261001.md 拆出的 19 条（净投入 71–142h，文档 §7 明示"按优先级插入执行表"）

| # | 行 | 内容 | 估时 | 信心 | 今日代码抽验（2026-10-04） |
|---|---|---|---|---|---|
| 1 | T12-asset-revision-ui | 资产陈旧提示+一键更新动线（detectStaleAssetRevisions 零生产调用方） | 2–4h | 高 | **仍缺**：grep 仅 `assetRevisionSnapshot.ts` 定义+测试，零消费方 |
| 2 | T12-reimport-editor-link | 再导入协调器编辑器接线（DeepAssetReimportCoordinator 零 apps 消费） | 4–8h | 中 | **仍缺**：grep 仅 deep-engine 定义/测试/index 导出 |
| 3 | T14-rootmotion-ui | 根运动/动画事件 UI 开关（setModelRootMotion 无 .tsx 消费） | 2–4h | 高 | 未单独复验（batch1 grep 证据在案） |
| 4 | T14-root-rotation-apply | 根运动**旋转**应用到实例 | 2–4h | 中 | **仍缺**：`apps/web/src/viewer/viewerEngineRootMotion.ts:25` 注释至今为"旋转增量本切片只记录不应用…留待下一切片" |
| 5 | T14-import-version | 导入版本验证（asset hash/schema/bind pose 读回） | 2–4h | 中 | batch1 判零实现 |
| 6 | T14-gpu-skin-cost | 100/1000 GPU 骨骼上传/绘制 P50/P95 遥测 | 4–8h | 低 | batch1：无 palette 上传/绘制遥测 |
| 7 | T14-unified-playchain | Native/WASM/TS 统一播放链 | 8–16h | 低 | batch1 判大项仍缺 |
| 8 | T15-ik-crosshost | Native/WASM/GPU IK | 6–12h | 低 | t14-21-batch 判"弱余项（随需求触发）" |
| 9 | T15-pose-library | 大库姿态索引/过渡混合 | 6–12h | 低 | 同上"弱余项" |
| 10 | T15-a5-skeleton-naming | A5 骨架命名（Mixamo 类兼容） | 2–4h | 中 | batch1 判零命中 |
| 11 | T16-rootmotion-editor-physics | 角色根运动→物理接线（queue_character_root_motion 零命中，batch1 称"T16 最核心剩余"） | 4–8h | 中 | t14-21-batch 判"角色四驱动已验"，两文档冲突 |
| 12 | T16-character-polish | 站滑平移加速度+BVH 每 tick 差集优化 | 4–8h | 中 | "弱余项" |
| 13 | T16-facial-morph | 离线 morph 编辑器消费（无 UI、无 setMorphWeight） | 6–12h | 低 | "弱余项" |
| 14 | T17-collider-source-ui | collider 来源选择器 UI（面板硬编码包围盒语义） | 2–4h | 高 | **仍缺**：grep colliderSource/collider 来源 零命中；t17-scope-lock 自己说"按估时表主线顺序排入"，从未排入 |
| 15 | T17-tolerance-freeze | 跨端通用数值容差冻结 | 2–4h | 中 | t17-scope-lock 同上未排入 |
| 16 | T17-concave-decomposition | 凹体凸分解（VHACD/compat 升级） | 4–8h | 低 | 条件触发（SDF 路线已替代，[建议不做]可接受） |
| 17 | T18-hair-minimal | 毛发最小闭环（hairChainSolver 仅 CPU 参考，无渲染消费） | 4–8h | 低 | 未排入 |
| 18 | T18-vehicle-integral | Rapier raycast vehicle 整车四轮（非赛车级） | 6–12h | 低 | 未排入 |
| 19 | T18-fixedstep-host | FixedStepClock 接宿主帧循环 | 1–2h | 高 | **部分**：E3 行只补了 `physics/index.ts` 导出面（账本六十六），宿主接线明确"属 T19/Play 域后续如实登记"（e3-t23-rate-parity-20261002.md）——仍未接 |

#### B. t-audit-batch2-20261001.md 拆出的各组新拆行（文档 §7 汇总表）

| 组 | batch2 判定（10-01，代码级） | 拆行 | 后续 scope-lock（10-02）判定 | 裁决 |
|---|---|---|---|---|
| T19 | 仍缺（7 尾项零覆盖） | T19-A 12–24h + T19-B 6–12h | "AGV 已有；navmesh 一项 2-4h 条件触发"（范围缩水） | 行外遗漏（条件触发类，合并 T19-A/B 口径） |
| T20 | **仍缺**（排序/事件读回/LUT/火焰接线/烟体/实机阶梯全缺，附代码证据） | T20-A 8–16h + T20-B 4–8h + T20-C 12–24h | "透明排序/曲线 LUT **已在域内**" | **疑似错误关闭**：今日 grep 复验 `pbrParticlePass.ts` 无 sort、`particleCurves` 零消费方、`modelFireEffect.ts` 不接 particleBudget/curves——与 batch2 证据一致，[行外遗漏] |
| T21 | 部分覆盖 | T21-A 6–12h + T21-B 12–24h + T21-C 1–2h | "deep2d 域+矩阵已有；骨骼/触控/动作映射弱余项" | T21-C（`gate:object-tree-100k` 纳入根 CI，1–2h 高信心）为无争议小遗漏；A/B 条件触发可接受 |
| T22 | 主体覆盖/冻结 | T22-A 4–8h（X_T 装配/名称/颜色语义消费）+ T22-B 条件 | t22-bounded："未支持范围保留后继，不扩样本" | T22-A 为登记后继未排程，[行外遗漏-中] |
| T23 | 部分覆盖 | T23-A~E 21–42h | t23-scope-lock："告警回放链已闭合；真缺口=工业数据质量位 2-4h + 数据谱系 2-4h" | 两小项登记后未排程，[行外遗漏] |
| T24 | 主体覆盖 | T24-A~D 18–36h | 后续五批已做证书/Sign/SignAndEncrypt/路由/preview/前端表单；SubscriptionTransfer=栈硬边界 | **backfill（OPC UA Historical Access）与质量可视化两项未做未排程**：grep HistoricalAccess/backfill 零命中，[行外遗漏]；OCSP 栈外登记 [建议不做] |
| T27 | 主体覆盖（"标签 UI"注记） | T27-A/B 8–16h | t27-scope-lock：标签/长事务/崩溃草稿已是生产实现（有文件级证据 useSceneHistoryState/workspaceRecoveryStore）；低频域记账条件触发 | 可调和，[行内已闭]+条件触发 |
| T28 | 主体覆盖 | T28-A 4–8h（在线逐步桥） | t28-scope-lock："三端全齐（Web Panel+WASM pose+Native instance_pose），单步控制归 T30 口径" | 可调和（Native 会话条件触发 3-6h 已登记），[行内已闭-带条件项] |
| T29 | 部分覆盖 | T29-A/B/C 18–36h | t29-scope-lock：告警挂载/ambient/混音 Web 三项已实现（有文件级证据 alertAudioDirector/viewerEngineSpatialAudio）；Native 3D 声音条件触发 3-6h | 可调和，[行内已闭-带条件项] |

**冲突族结论（同族条款）**：`t14-21-batch-scope-lock-20261002.md` 对 T14/T20 的"已覆盖，关闭"判定
与 10-01 深度审计的代码证据及今日抽验直接矛盾——T20 的"透明排序/曲线 LUT 已在域内"实为
"CPU 参考层文件存在"，GPU 渲染消费端（排序核/LUT 上载/火焰接线/事件读回）从未接生产。
与 T12 初版误判（02:30 更正）、N5 错误关闭（账本七十八实测纠正）同机制：**把"定义存在"当"消费闭环"**。
建议对 t14-21-batch 的 T14/T20 两行做一次 N5 式"实测纠正重闭"。

#### C. T08/T09 scope-lock 锁定的 6 个新工作包（t08-t09-scope-lock-20261002.md，"转为新工作包按主线顺序排入"，从未排入）

| 工作包 | 估时 | 现状 |
|---|---|---|
| aniso/transmission IBL split-sum 消费 | 2–4h | 核已有，补 IBL 分支+双端对拍 |
| SSS 次表面散射节点 | 8–16h | 全仓零命中 |
| 毛发/毛发节点（渲染侧，与 T18-hair 相关） | 8–16h | 全仓零命中 |
| 体积云层 | 8–16h | cloudLayer/volumetricCloud 零命中 |
| 水面反射/折射 | 8–16h | waterSurface/waterRefract 零命中 |
| 多灯雾（VolumetricLight 单灯输入） | 4–8h | 合同与 GPU 分摊待设计 |

### 2.2 路线二：规格余项扫描（61 行关闭批次遗留下的登记缺口）

| # | 项 | 出处 | 定性 |
|---|---|---|---|
| 1 | **outline 完整实现**（账本收 instance surfaceFlags bit256 + WGSL outline pass） | outline-deep-webgpu-mine-20261002.md:31"留引擎专批"；今日 grep `materialEffectLedger.ts` 无 outline 位消费，WGSL 零 outline pass | [行外遗漏]（编辑器手动切 Deep 已有守卫拦路，开发者直调编译链仍撞账本密码错=引擎 fail-closed 保留） |
| 2 | **场景编译器 materialLosses 传播**（场景级导入损失可见性缺口） | n5-material-import-profile-20261003.md:96-97、135"明确不做…场景级损失可见性仍是缺口"；pathTraceRenderPacketScene.ts:15 对非空直接 throw | [行外遗漏] |
| 3 | **J3-E mixed 候选销毁 lost reason 排障保真**（上报只带 prepare 失败文案、丢 destroyed 根因，"后续小批修"） | j3-e-mixed-recovery-20261002.md:18；今日 grep lostReason/销毁根因 产品源零命中 | [行外遗漏-小] |
| 4 | **J3-E 11 域升格之 animation-policy 与 camera-constraints**（唯一需引擎 API 设计批的 2 域） | 账本追加五十四（j3-e-domain-upgrade-batch2）："需引擎 API 设计批的仅 animation-policy 与 camera-constraints" | [行外遗漏]（其余 6 域结构性不可升有裁决书，[行内挂起-拍板]可接受） |
| 5 | **assetDeletionImpact UI 接线**（"UI 接线待 G2 完成后接入"，G2 早已完成） | t12-scope-lock-20261002.md"UI 接线待并行批次收尾"；今日 grep 零 UI 消费方 | [行外遗漏-小]（与 A 表 #1 同域可合并） |
| 6 | glTF 动画扩展导入整体 fail-closed（validateAnimationDocument 对一切 extensionsUsed/Required 抛 unsupported） | packages/deep-engine/src/gltf/animationImportValidation.ts:22-24；无任何任务/规格登记此边界 | [行外遗漏-能力边界]（需先裁决是否支持 KHR 动画扩展族） |
| 7 | I-C16 后继：纹理/单面/alpha/扩展层/HDR 环境/局部 IES + T10 硬件 RT/refit/降噪 | remaining-tasks-estimates-20260930.md I-C16 行"另计" | [行内挂起-拍板]（登记性质） |
| 8 | I-C19 后继：全局预算双驻留/LUT 跨代共享 | 同上 I-C19 行 | [行内挂起-拍板] |
| 9 | I-C21 后继：物理 HDR 面板显式未测 | 同上 I-C21 行 | [行内挂起-拍板] |
| 10 | I-C23 附带：第二网格跨设备 ~2e-3 局部方差专项 | 账本追加五十（j3-e-domain-upgrade-batch1 Open 发现） | [行外遗漏-小] |
| 11 | B1（P4 子题）Native v2 守卫/独立包路径开放 | hc7p4-ready-evidence-20261002.md（账本七十三引用）："B1 缺口…属引擎 Native v2 域"；追加六十"B1 保持 partial" | [行外挂起-窗口/cargo] |
| 12 | H-C6-S2 增量：LLM 提炼器/web 面板/语义域匹配/跨项目聚合 | 账本追加二十四"行剩余增量项" | [行外挂起-拍板] |
| 13 | H-C7-P2 遗留：P3 落地后模板扩容/P4 基准复用对照 | 账本追加五十三"H-C7-P2 行主体完成（剩余=…）" | [行外挂起-拍板] |
| 14 | H-C6-S3 余量：403 组件能力标签（文档增强）、operations 参数面 | 账本七十六（hc6s3-v2）"余量登记" | [建议不做/低] |
| 15 | inventory v1 回写（18 业务域矩阵回写主线程待办） | 账本五十八边界"inventory v1 回写归主线程待办" | [行外遗漏-小]（v2 对账已覆盖大半，回写文档动作） |
| 16 | e2-z4 观察项：dashboard 令牌外硬编码灰批量收敛、DashboardPlayback.css 旧变量名、skippedUnpainted 图标 3:1 断言 | e2-z4-visual-regression-20261003.md:127-133"登记观察项（如实移交）" | [行外遗漏-低] |
| 17 | e2-z4 移交：1920/480 断点复跑（有 gate-ui-report-20260905 先例） | 同上:141-143 | [行外遗漏-低]（浅色两轮已入优化批次 E，断点未明确列入） |
| 18 | E1 gate-online-flow.mjs 旧选择器与 UI 脱节 | 账本六十八"归该 gate 维护者" | [行外遗漏-小] |
| 19 | Z1 SSR 默认策略拍板（默认关=对齐 HDRP vs 默认开+首启帧时门，"二选一，不允许默认不测"） | z1-default-quality-audit-20260930.md:41,60 | [行内挂起-拍板]（contactShadows 已默认开，SSR 未裁） |
| 20 | Z5 审计脚本门禁化进 CI 裁决 | z5-value-audit-20261003.md:22 | [行内挂起-拍板] |
| 21 | monaco esm 细粒度 import 重构（ts.worker 双份 6.6M 根治） | 账本一百零二"登记为对标优化阶段 B 批主项" | [行内-优化批次 B 已承接] |
| 22 | t-audit-batch2:214 参数/行为 IR 热应用（"实现仍缺，设计归属 G2"） | t-audit-batch2-20261001.md:214 | [行外遗漏]（G2-S2b 已做 Play 草稿呈现，运行中热应用属 H-C6-S1 已做热插——需一次口径核对后定性，倾向 [行内已闭]） |
| 23 | T22 排除项：JT8.x 网格/PMI 语义/第三方贴图/多 body 装配/非共轴 trim/NURBS | t22-bounded-acceptance-20261001.md:18,24-26 | [行内挂起-拍板]（有界验收明示保留后继；T22-A 已列 B 表） |
| 24 | A2-next 行剩余：旧核探针/运行时消费回路 | a2-next-sdf-barrel-20261002.md"行剩余：native cargo 复验/旧核探针/运行时消费回路" | [行外挂起-窗口/cargo] |
| 25 | F6/T18 边界：多障碍重叠/旋转 cuboid+风组合/高频帧性能（禁）/Native 软体（禁） | 账本六十九"诚实边界" | [行外挂起-窗口] |
| 26 | C8 质量门 RED：qualityCertified=false，"最终批准权留用户" | c8-s3-ld-registry-adjudicated-entries-20261002.md:41；61-row-status.json note 字段 | [行内挂起-拍板] |

### 2.3 路线三：代码内 TODO/FIXME

`packages/*/src`、`apps/*/src`（ts/tsx/rs/wgsl）grep `TODO|FIXME|HACK|XXX`（含注释前缀变体）：**零命中**。
Rust 侧 `#[ignore]` 仅存在于 GPU 用例（gpu_occlusion_tests.rs:5 等 crate 惯例"显式 --ignored 运行"），属测试分级非债务。
结论：无代码内散落任务，全部余项都在规格层——这与"规格余项扫描"成为本次排查主战场的判断一致。

### 2.4 路线四：测试跳过项

- **无条件 skip/todo：零**（grep `it.skip|describe.skip|test.skip|it.todo` 全仓无命中）。
- **条件跳过 skipIf（环境门控，合理）**：apps/api 13 文件级（JT 外部 fixture 包 7 处、E57 Windows Job 2 处、
  win32 平台 5 处、真实 Chrome 集成 3 处、隔离 PostgreSQL 2 处、Android 构建工具 1 处、SolidWorks 预览 1 处）；
  apps/web 4 处（FILTER_GLYPH_RUN_E2E、OPTIMIZER_LAYER_BENCH、prefab 外部资产目录、DEVICE_SIGNAL_BENCHMARK）。
  全部为外部依赖缺失时的显式跳过，带 `[skipped: …]` 可读原因，非隐藏债务；外部 fixture 包是否补齐属样本治理，[建议不做/按需]。
- **deep-engine 全套 51 skipped**（n5-material-import-profile-20261003.md:111 记录 5962 通过/10 失败/51 skipped）：
  与 GPU/浏览器依赖的环境门控一致，未发现"skip 掩盖真实用例"。
- **同批 10 失败归属**：lab/c8F32Inputs、lab/j3DFullLayerMatrix、iesSamplingWgslChecksum、cascadedShadowMathWgslChecksum。
  后两个已被账本九十九收口（ies 自愈+CSM 现状化）；**前两个（c8F32Inputs/j3DFullLayerMatrix）在九十九批与后续记录中均无收口登记**，[行外遗漏-待验证小项]。
- 今日 web 全量 3 skipped 与账本八十一记录一致（3 败已归位）。

### 2.5 路线五：用户拍板/窗口项（与任务提示清单核对后的补全版）

**行内挂起-GPU（统一验收批次 1，3 行，账本一百）**：
1. B2/T11 帧时批（冻结树 A/A+A/B 冷暖切、输入 P95/P99、有效首帧、20 次进出内存）
2. J3-E-GPU（帧时定标+≥5 成对统计；probe 回移植已完成、SHA 重锚 ce05fd52）
3. Z2/Z3.5（默认档真机验证与回退 + 自适应档 softness knob 扩展，账本九十八改道登记）
前置：OrayIdd 虚拟显示占枚举首位致 D3D12 E_NOINTERFACE，需**用户级禁用该设备**（账本一百零一，主线程不动刀）。

**行内挂起-拍板**：C8 qualityCertified 最终批准（#26）；Z1 SSR 默认策略二选一（#19）；Z5 门禁化进 CI（#20）；
I-C16/I-C19/I-C21 登记后继（#7/8/9）。

**行外挂起-窗口/cargo**：F5 真机 GPU 像素门+F5 native cargo 复测（账本九十四/F5-l4）；
F4 帧时（空窗批）/动态档位往返/threeBridge opt-in（账本追加十六）；F2 逐 pass 计时/跨帧 Hi-Z×折叠/全三角口径（账本追加二十）；
F3 帧时数字/页缝 gutter 归 C9（账本追加八）；P4 D3（GPU timing 禁测）/D1（用户面口径）（账本七十三）；
A2 native cargo 复验/旧核探针/运行时消费回路（#24）；B1 Native v2 守卫/独立包路径（#11）；
F6 四项边界（#25）；H-C7-P1 真实 Claude/Codex 客户端进程接入+显式取消 TTL 覆盖（账本九十二"余量如实"）；
api dist 重建链含 cargo（e2-z4 如实声明④）。

**行外挂起-拍板**：F5 方案 B 叠加（方向 atlas，锐度超 L1 登记项，账本九十四）；H-C6-S2 增量四项（#12）；
H-C7-P2 模板扩容（#13）；I-C14 WESL/I-C27 地形/I-C31 CoreCLR/I-C22 散布/J2-B8 簇光照/R1/R5/A4/U1/H 远期
（remaining-tasks-estimates-20260930.md"观察、条件触发与暂不实施"表）——后八项为有意条件触发，[建议不做]。

### 2.6 路线六：对标优化阶段覆盖核查

`optimization-phase-plan-20261003.md` 六批次 vs `deep-engine-gap-vs-unity-ue-2026-09-27.md` 49 项缺口（§4.1 八项工业关键）：

| 工业关键缺口 | 优化批次承接 | 裁决 |
|---|---|---|
| N2 现场实时数据连接运行时 | 61 行 T24 已覆盖持久订阅/checkpoint/证书/安全；**backfill+质量可视化未承接**（B 表 T24 行） | 部分，剩 2 项行外 |
| P1 物理可视化调试器 | T28 三端全齐+容差冻结归 T17 | 大部覆盖；跨端通用容差冻结未做（A 表 #15） |
| L1 HLOD 自动生成 | F2 行已闭（生成/API/合批在库） | 覆盖 |
| E2 全局统一 Undo/Redo 事务 | P3 第四批已接场景命令域进宿主历史；**资源/资产/全局事务层无行承接** | 部分，行外候选（gap 文档判"高"必要性） |
| D3 差分更新/签名/可回滚发布 | **无任何行承接**（gap §4.1"现场升级不能整包重传"） | [行外遗漏-高] |
| D4 崩溃捕获与现场诊断 | J3-E 驱动显存标定+guards；本地诊断包无行承接 | 部分，行外候选 |
| Q1/Q2/Q3 剖析/内存可视化/驱动回归矩阵 | F1 面板格升级+T00 设备矩阵骨架（多卡条件触发）；Profiler 产品化 gap 判"高"必要，T25 面板已有格 | 部分覆盖；内存可视化产品化无行承接 |
| E1 受限 Play 模式 | G2-S2b + H-C6-S1 热插 + T30 Native 条件触发 | 大部覆盖 |

批次覆盖面两处补充：①批次 E 只写"全页面深/浅两轮终验"，**1920/480 断点与动效帧时实测未列入**（e2-z4 移交项 #17/动效声明①）；
②批次 F"屎山扫描门禁化"与 Z5 裁决（#20）应合并，避免两个"门禁化"分头未决。

---

## 3. 五类定性计数

| 定性 | 计数 | 说明 |
|---|---|---|
| [行内已闭] | 23 | T00-T32+N5 核查行 + T24/T27/T28/T29 与 batch2 可调和组 |
| [行内挂起-GPU] | 3 | B2/T11、J3-E-GPU、Z2/Z3.5（批次 1，卡 OrayIdd 用户级禁用） |
| [行内挂起-拍板] | 7 | C8 批准、Z1 SSR、Z5 门禁化、I-C16/I-C19/I-C21 后继、T22 排除项 |
| **[行外遗漏]** | **26** | A 表 19 条（t-audit-batch1，其中 4 条高信心+7 条中信心共 27–54h 可近期排）+ B 表增量（T20 三条、T19、T22-A、T23 两项、T24 backfill/质量视图、T21-C）+ §2.2 表 #1/2/3/4/5/6/10/15/18/22 及 T08/T09 六工作包（明细见 §2，部分相互合并） |
| [建议不做] | 12+ | 凹体凸分解、JT8.x/PMI 样本、Nanite/Blueprint/Lumen 本体、通用 ECS/流体、XR 全矩阵、数字人、游戏多人、OCSP、条件触发观察项（I-C14/C27/C31/C22/J2-B8/R1/R5/A4/U1）等——remaining-tasks"明确不做"清单 + gap §4.2，均为有意裁定 |

（行外遗漏 26 为去重后主计数：A 表 19 条中 #8/9/12/13/16/17/18 七条为低信心/条件触发可挂起，
B 表增量与 §2.2 规格余项部分互相合并；逐条见 §2 对应表，未重复计入。）

---

## 4. 前 10 最重要的行外遗漏（建议处置顺序）

1. **T20 GPU 粒子渲染消费族（排序核/曲线 LUT/火焰预算接线/事件读回，24–48h）**——
   t14-21-batch 的"已在域内"为疑似错误关闭，今日代码 grep 复验仍缺；直接对标帆软/Unity 粒子语义完备性
   （t-audit-batch2-20261001.md §2 + 今日抽验）。
2. **T14 根运动族（旋转应用/UI 开关/导入版本验证，6–12h 高中信心）**——
   `viewerEngineRootMotion.ts:25` 注释在案；角色动画是四级行走动线的地基（t-audit-batch1 §3）。
3. **T12 交付悬空族（assetDeletionImpact UI 接线 / detectStaleAssetRevisions 动线 / DeepAssetReimportCoordinator 编辑器接线，6–12h）**——
   三套已交付能力零生产消费方，违反"交付即接线"惯例（t12-scope-lock + 今日 grep）。
4. **T24 backfill（OPC UA Historical Access）+ 数据质量视图**——
   gap §4.1 判"数字孪生活数据命脉"；T24 行关闭时登记余项但从未排程（t24 关闭链 + grep 零命中）。
5. **T08/T09 六工作包（aniso/transmission IBL、SSS、毛发、体积云、水面、多灯雾，44–64h）**——
   scope-lock 自己"转为新工作包排入"却无排程记录；直接对标 Unity HDRP/UE 特征清单（t08-t09-scope-lock）。
6. **outline 引擎专批（账本收 bit256 + WGSL outline pass）**——
   编辑器入口已用守卫绕开，但"产品带 outline 的 showcase 在 Deep 下不可用"是真实能力缺口
   （outline-deep-webgpu-mine-20261002.md:31）。
7. **D3 差分更新/签名/可回滚发布**——gap §4.1 八项工业关键中唯一完全无承接项（对标西门子现场交付纪律）。
8. **场景编译器 materialLosses 传播**——场景级导入损失可见性缺口，N5 关闭时明示"仍是缺口"
   （n5-material-import-profile-20261003.md:135）。
9. **T17 collider 来源选择器 UI + 跨端容差冻结（4–8h）**——t17-scope-lock 明言"按主线顺序排入"，
   从未排入；物理可信度取证链的最后一环。
10. **J3-E 残项：lost reason 排障保真小批 + animation-policy/camera-constraints 引擎 API 设计批**——
    两项均为关闭批次明文"留小批/需设计批"且与批次 1 的 J3-E-GPU 行相邻，宜随 GPU 窗口解锁一并收口
    （j3-e-mixed-recovery-20261002.md:18 + 账本五十四）。

## 5. 诚实条款

- 本报告为只读静态审计：未运行 cargo、未修改任何源码、未 commit/push；`jc-i-continuation-20261001.md` 只读。
- 测试现状引用 10-03 批次落盘统计（n5 规格记录的 5962/10/51 与账本八十一的 5543/3/3），未重跑全量测试；
  c8F32Inputs/j3DFullLayerMatrix 两 lab 失败的当前状态按"无收口登记"定性，处置前应先复跑确认。
- T14/T20"疑似错误关闭"的裁决依据是 batch1/2 的代码级证据 + 本次 6 处抽验一致；t14-21-batch 的其余四行
  （T15/T16/T19/T21）有"弱余项登记"措辞，按条件触发可接受，未列入错误关闭族。
- api 侧 I-C21 ownerDocument 既有债经实测 `tsc --noEmit` exit=0 已不存在，从候选中撤销（诚实更正记录在案）。
- 工时数字全部转引自原规格（t-audit-batch1/2、t08-t09-scope-lock），未经重新估算。
