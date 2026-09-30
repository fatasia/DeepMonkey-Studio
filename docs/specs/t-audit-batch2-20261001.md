# 历史 T 全包剩余范围校准 · 第二批核查报告(T19/T20/T21/T22/T23/T24/T27/T28/T29/T30/T31/T32)

- 日期:2026-10-01(北京时间)
- 性质:纯核查与范围锁定,生产代码零改动。权威表:`docs/specs/remaining-tasks-estimates-20260930.md` §"历史 T 全包的剩余范围校准"。
- 方法:逐组读 `docs/reports/deep-core/T{XX}-implementation.md` 尾项/partial 清单 → grep 当前源码 + `git log`(以 09-28 至 10-01 提交窗为主)交叉验证 → 每个子项给三选一结论:**已覆盖**(提交+测试证据)/ **仍缺**(拆精确任务行)/ **归属他项**(不重复计时)。
- 诚实条款:证据不足处显式写"无法确认";本报告不宣称任何"整包已全验",只锁定"估时归属"。

## 核查窗口内的关键提交(十二组共用)

| 提交 | 日期 | 与本批相关的范围 |
|---|---|---|
| `7bdb73e0` | 09-28 | 多线收口大批:T19 人群模块首次入库、T20/T21/T22/T28/T29/T30/T31 各自切片文件入库、T22 权威工业格式计划恢复入库、X_T/JT 纹理合成链 |
| `1e07cdaf` | 09-28 | 十大能力线接线:受限 Play(T30)、受限行为脚本命令适配/Play 接线(T31)、dataReplay/alertIngest 客户端 |
| `cb387b50`+`52d3c74a` | 09-30 | I-C25 增量 Play 恢复(planIncrementalPlayRestore,T30 家族) |
| `fb8f79d4` | 09-30 | Play 恢复重试门与渲染器切换 settle(T30) |
| `5b89aca6`/`43fdb735` | 09-30 | I-C17 curl 核生产关闭(T20 重复项排除) |
| `e1261af7` | 10-01 | J3-E 编辑器播放头恢复 + 设备矩阵 CPU 门(T30/T27 家族) |
| `37c98eab` | 10-01 | 运行时模块宿主时钟注入(ENG-runtime-purity 域,**非** T19 统一时钟) |

---

## 1. T19 —— 导航/人群/实体计算与时间(navigation/AGV/SimulationEngine)

**尾项清单**(T19 报告 §9,7 项):navmesh/A* 寻路、动态障碍更新、坡度/步高、对向人流让行、统一求解步长/暂停/事件时间/回放贯通(SimulationEngine 端口)、TS/Native 跨端消费与 SoA wasm ABI、10k 到达收敛断言。

**核查证据**:
- `runtime_navigation_crowd.rs` 于 `7bdb73e0`(09-28)首次入库(1181 行);模块文档明示 "Not in this slice (remaining §T19 subitems): static triangle navmesh path planning, dynamic obstacle re-update, slope/step-height profiling, and the TS/native cross-boundary consumer wiring"(`packages/deep-engine-native/src/runtime_navigation_crowd.rs:39-42`)。
- 10k 档仍为成本档:源码 L1054 注释 "Cost tier only: no arrival assertion";到达断言只有 100/1000 档。
- 对向让行:全文件无 right-hand/opposing-flow 逻辑。
- wasm ABI:`packages/deep-engine-wasm/src/` 无 crowd/navigation 模块;`CrowdState` 无 TS 消费方;contracts/simulationEngine.ts 与 plant-lite 均无 crowd 消费(plant-lite 侧 "crowding" 命中是多目标优化 NSGA 拥挤度,不同域)。
- 跨端统一时钟:`37c98eab`(10-01)注入的是 webgpu 管线/pipelineCache 宿主时钟,属估计表 `ENG-runtime-purity` 行,与 T19 无关;T23 校准矩阵只出方案未接运行时;`advance_ticks` 语义仅存在于 deep-engine physics(T18 FixedStepClock,注释"同 T19 advance_ticks 语义"),非人群驱动。

**结论:仍缺**(7 尾项全部未被 09-28 后提交覆盖)。底座已有(不重建):60Hz 固定步确定性驱动、SoA、批调度、窄道排队/墙滑行、plant-lite DES 层 AGV 传输网络。

**新拆任务行**:

| 任务行 | 范围 | 文件 | 估时 | 依赖 |
|---|---|---|---|---|
| T19-A | 人群连续空间后继:navmesh/A*(或分层绕行)、动态障碍列表更新、坡度/步高、对向让行规则 | `runtime_navigation_crowd.rs` | 12–24h | 低信心 |
| T19-B | 跨端接线:wasm ABI 暴露 SoA 状态 + SimulationEngine 端口贯通 + 10k 到达断言升级 | `deep-engine-wasm`、`contracts/simulationEngine.ts` | 6–12h | T19-A 或独立 |

## 2. T20 —— GPU 粒子与体积特效(gpuParticleRuntime/B3 MRT)

**重复项排除**:I-C17 已于 `5b89aca6`/`43fdb735`(09-30)生产关闭(curl 核/SDK phase/seed/关停/TAA+bare HDR 双 fresh);i-c17 报告尾注明"完整作者节点/T20 后继保留"——T20 后继不被 I-C17 吸收。

**尾项核查**(T20 报告 GPU 联测清单 6 项 + 剩余子项 4 项):
- 透明排序:`pbrParticlePass.ts` 无任何 sort 调用;blend 为 premultiplied(one / one-minus-src-alpha)+ coverage max,`depthWriteEnabled: false`;`gpuParticleWgsl.ts` 无排序核 → **仍缺**。
- 曲线 LUT:`particleCurves.ts` 仅 CPU 参考,webgpu/apps/contracts 全仓无消费方 → **仍缺**。
- 火焰预算遥测:`modelFireEffect.ts` 仍是独立 THREE.Points 自绘路径,不接 `particleBudget`/`particleCurves`/telemetry;`degradationReasons` 无 FrameMetrics/用户面出口 → **仍缺**。
- 事件读回:death/collision GPU 事件缓冲不存在(`gpuParticleBurstStage.ts` 的 eventBuffer 是 burst 事件,非粒子生命周期事件)→ **仍缺**。
- 有边界烟体求解:仍为 1D 扩散参考(`smokeDiffusion.ts`),3D 网格求解/体积渲染无 → **仍缺**(通用流体维持排除)。
- f32 统计对拍与 10 万/100 万实机阶梯:I-C17 只做了 flow-field 16 粒子×8 步;预算档实机阶梯无证据 → **仍缺**(联测性质)。

**结论:除 I-C17 外仍缺**。已有底座(不重建):GPU 粒子运行时/发射/爆发/间接绘制、CPU 统计/预算/事件/曲线四层、生产呈现通道(TAA alpha 掩码 `55f410c6`)。

**新拆任务行**:

| 任务行 | 范围 | 文件 | 估时 | 依赖 |
|---|---|---|---|---|
| T20-A | 透明排序核(逐粒子深度或分箱)+ death/collision 事件读回 + 实机对拍/预算档阶梯联测 | `gpuParticleWgsl.ts`、`pbrParticlePass.ts` | 8–16h | 真机 GPU |
| T20-B | 曲线 LUT 上载 + 渲染端 size/alpha over life + modelFireEffect 接预算/曲线层 + 降级遥测出口 | webgpu/contracts/viewer | 4–8h | T20-A(同 pass) |
| T20-C | 有边界烟体 3D 网格求解首刀 + 体积渲染(分辨率收敛/质量误差复用 1D 口径) | 新模块 | 12–24h | 独立;低信心 |

## 3. T21 —— 2D/UI、输入、文本与无障碍(retainedUi/Deep2D/input)

**已覆盖**(证据:报告切片 + `7bdb73e0` 入库):
- 100,000 行真实浏览器挂载/选择/删除/键盘:`gate:object-tree-100k` 脚本在库,报告三轮 P95 31.6ms 实测;`WindowedSceneRows`/`FlatSceneObjectList` 优化与 9 测试在库。
- 复杂文本/输入矩阵:`complexTextMatrix.ts` 九语种样本、bidi plaintext、`imeComposingKey` 家族清剿 13 文件、浏览器脚本 `qa-t21-text-input.mjs` 与截图证据。以上全部随 `7bdb73e0` 入库。

**仍缺**(grep 证据):
- 2D 骨骼/Sprite/Tilemap:`deep2d/*.rs` 与 `webgpu/deep2d/` 零 sprite/tilemap/skeletal/bone 命中 → **仍缺**。
- 独立 2D 物理:全仓无 physics2d 命中 → **仍缺**。
- UIA 跨层联动:native `app/accessibility.rs`/`native_ui/chart_a11y.rs` 有 UIA 实现,但与 web 场景树之间无跨层消费合同(报告明示"UIA/辅助技术树未测") → **仍缺**。
- 移动触控:apps/web 无 touch 输入面命中 → **仍缺**。
- 动作映射:无统一 action mapping/rebinding 系统(命中均为素材导入 rebinding,不同域);手柄动作映射在权威表属观察项 U1 → 手柄部分**归属他项(U1)**,统一动作重绑定本体**仍缺**。
- `gate:object-tree-100k` 未纳入根 CI(仅 app script)→ 小尾巴**仍缺**。

**新拆任务行**:

| 任务行 | 范围 | 文件 | 估时 | 依赖 |
|---|---|---|---|---|
| T21-A | UIA 跨层联动合同 + 移动触控输入面 | native accessibility、web input | 6–12h | 低信心 |
| T21-B | 2D 骨骼/Sprite/Tilemap 与独立 2D 物理 | deep2d 域 | 12–24h | 建议按真实场景需求触发 |
| T21-C | `gate:object-tree-100k` 纳入总 CI | 根 CI 配置 | 1–2h | 高信心 |

## 4. T22 —— 工业格式、精度与语义(工业格式唯一计划/parser/fixtures)

**已覆盖/已冻结**(证据充分):
- JT 8.x 网格:用户 09-28 冻结声明(报告"本轮冻结声明"节);`docs/format-support.md` 明确 8.x=仅结构 `inspect`、"8.x 网格、PMI、UV 与图像绑定均未验证"、17 份本地样本不可分发 → **归属"明确不做/冻结"**,不拆实现任务;复入条件=真实可分发 8.x 网格样本出现,且受权威表"被删除样本追索不得复入"约束。
- JT 纹理:真实带纹理样本追索按用户指令终止(权威表"明确不做:…JT纹理…");本地合成链(`textureImage.ts`/`jtTexturePng.ts`/`independent-texture` 样本)已交付并经 `7bdb73e0` 入库、用户画面验收通过 → **已覆盖(合成证据边界)**,真实样本声明不再升级。
- X_T 曲面与生产 profile:较报告又前进一大步——`builtin-x-t-revolved-subset`(V24.1 单体共轴旋转件,plane/cylinder/cone/torus,1 份 MIT 真样本 L2 通过,`visual-complete` 合规生产)+ xt-reader 通用档(平面/圆柱/圆锥/球面族,108 份真实样本回归)已入 `docs/format-support.md`/`docs/builtin-profiles.md` 并随 `7bdb73e0` 入库;`geometry.rs` 含圆柱/圆锥参数化与圆缺口/内环 fail-closed 测试 → **主体已覆盖**。parasolid-kit 五精确 key 维持"本地研发验证"(不升级)。
- 第三档 schema-aware:权威文档明确"不满足内置离线硬门槛,不计入合规生产能力" → **归属"明确不做"**(与硬门槛一致)。

**仍缺**:
- JT PMI 语义:`pmiSegment.ts` 无 dimension/annotation/datum 解析(仍 `pmi-structure-only`)。受"样本追索不得复入"约束,语义解析依赖真实带标注样本 → **条件触发**(有样本再立切片)。
- X_T 装配/名称/颜色语义:trim/名称/颜色/装配仍如实进 losses;消费端(结构树/属性面板)对 X_T 装配语义无消费 → **仍缺**(小切片)。
- JT Rust→WASM→TS 编辑器专属链:partial 维持(现生产链是 TS reader→API→GLB→Web glTF,WASM 链价值待评估)→ **归属观察项**,不重复计时,除非产品决策要求该链。

**新拆任务行**:

| 任务行 | 范围 | 文件 | 估时 | 依赖 |
|---|---|---|---|---|
| T22-A | X_T 装配/名称/颜色语义出 losses 进 sidecar/属性消费 | api/conversion、web 属性面板 | 4–8h | 中信心 |
| T22-B(条件) | JT PMI 尺寸/标注语义解析 | `packages/jt-reader/src/pmiSegment.ts` | 8–16h | 需真实带标注 PMI 样本;无样本不动工 |

## 5. T23 —— 工业仿真校准与本地数据验证(plant-lite/Study)

**已覆盖**:
- deep-engine `localeCompare` 同族清剿(报告尾项⑤):`packages/deep-engine/src/textOrder.ts`(2026-09-28)已建,登记家族(packagePurity/identityGolden/shader compiler/compilerWgsl/variants/shaderPackage builder/gpuResidencyExecutor)全部改 import → **已覆盖**。相邻家族残留:`shadows/shadowPages.ts`、`virtualTextures/*` 尚有 6 处 `localeCompare`(按 textureId/shadow id 的 tie-break),不在 T23 登记清单内,建议 1–2h 同族收尾(**仍缺,小**)。
- C2 校准集:`ff0dab1f`(09-29)独立校准集 13 例两分(训练 6/保留 7)已交付——权威表已注明"C2 校准集已完成之外",本组不重复计时。

**仍缺**(grep 证据):
- 校准集/独立验证集分离与样本谱系:`calibrationModels.ts` 仍是单 golden 锚(`cf20cfbd6e97a617`),无 train/validation split、无参数版本/seed/输入来源谱系记录 → **仍缺**。
- 离线采集数据 schema 与质量检查:plant-lite 无;`operationsEngine.ts` 的 dataQuality(完整率)是维护模型窗口门禁,属相邻能力,可复用但不等同 → **仍缺**。
- 排队/守恒/机构解析案例库与随机模型 CI 报告对照:golden 仅校准场景 + goldenModels/golden16GeneticOptimization,无守恒/排队解析案例批 → **仍缺**。
- 告警定位→原因→历史回放业务链:`dataReplay.ts`(09-19)明确"告警引擎自产事件是派生数据,不进回放时间轴";`eventRecording.ts`(C4)无 alert 源;告警→回放链路无接线 → **仍缺**(C4 录制与三轴重放是可复用基建)。
- D2/T23-gradient(解析梯度 vs 有限差分):权威表已单列 `D2/T23-gradient` 行 → **归属他项**,不重复计时。

**新拆任务行**:

| 任务行 | 范围 | 文件 | 估时 | 依赖 |
|---|---|---|---|---|
| T23-A | 告警→原因→历史回放复核链(alert 源进 C4 录制或 dataReplay 时间轴+定位跳转) | api eventRecording/dataReplay、web | 8–16h | C4 已有基建 |
| T23-B | 校准/验证集分离 + 样本谱系记录(参数版本/seed/来源) | plant-lite golden | 4–8h | 中信心 |
| T23-C | 离线数据 schema/质量检查(复用 operationsEngine 完整率口径) | plant-lite/api | 4–8h | 中信心 |
| T23-D | 排队/守恒/机构解析案例库 + CI 报告对照 | plant-lite golden | 4–8h | 低信心 |
| T23-E | deep-engine shadows/virtualTextures 相邻家族 localeCompare 清剿 | 6 处 | 1–2h | 高信心 |

## 6. T24 —— 现场实时数据连接运行时(OPC UA/MQTT 订阅)

**已覆盖**:
- OPC UA 真实持久订阅(09-27 续切片,MonitoredItem/断线检测/恢复对账,64 测);
- 文件 checkpoint:`FileSubscriptionCheckpointStore` 已在 `apps/api/src/index.ts:212` 接 `config.dataDir` → **已覆盖**(与任务提示一致)。
- C4 事件级持久录制(`a23def9e`,09-29)消费订阅样本(sourceOrigin=subscription)并对账语义同源——录制侧质量可视化(EventRecordingPanel 完整性/源序)已由 C4 交付 → 归属 C4 域。

**仍缺**(代码证据):
- SubscriptionTransfer:`opcUaSubscriptionSource.ts:521` 明示"未实现:断线后由运行时重建订阅,断线区间数据不补发" → **仍缺**(也可裁决为"接受重建+缺口对账"语义并关闭该尾项,属产品决策)。
- 安全模式:固定 `MessageSecurityMode.None`/`SecurityPolicy.None`(L400-401);Sign/SignAndEncrypt 需宿主证书管理 → **仍缺**。
- backfill/恢复后补发(Historical Access):subscriptionRuntime/opcUa 适配器零命中 → **仍缺**。
- 订阅会话缺口语信质量可视化:web 全仓无 `persistent/status`/`DataSubscriptionGapReport` 消费方 → **仍缺**(注意与 C4 录制质量 UI 区分)。

**新拆任务行**:

| 任务行 | 范围 | 文件 | 估时 | 依赖 |
|---|---|---|---|---|
| T24-A | SubscriptionTransfer 或"重建+缺口对账"语义裁决与落地 | opcUaSubscriptionSource/subscriptionRuntime | 4–8h | 中信心 |
| T24-B | backfill:OPC UA Historical Access 按源能力接入 | opcUa 适配器 | 6–12h | 中信心 |
| T24-C | Sign/SignAndEncrypt + 宿主证书管理 | api 配置/证书面 | 6–12h | 低信心(需证书运维) |
| T24-D | 订阅会话状态/缺口报告用户面可视化 | web 数据面板 | 2–4h | 高信心 |

## 7. T27 —— 全局 Undo/Redo 统一事务与编辑恢复(scene history)

**已覆盖**:
- 统一事务 begin/commit/rollback + 动画域入账(切片一,全量 4611 测通过);
- Play 隔离记账门禁(T30 四路径);
- 播放头恢复:`e1261af7`(10-01,J3-E)editor playhead recovery(`animationPlayheadReader.ts` + `sceneRendererRecoveryPlayhead.test` 140 行)→ 任务提示的 J3-E 补充属实,归 J3-E 行不重复计时。

**仍缺**(grep 证据):
- 事务标签 UI:撤销/重做菜单无事务标签/"N/M 步"密度提示(useSceneHistoryActions 仅事务窗口拒绝注释) → **仍缺**。
- 低频域记账补全:`sceneAnimationCommands.ts` 的 `updateSceneAnimation`(帧率/吸附设置)仍不入账;工程分析规则命令无 recordSceneEdit 命中 → **仍缺**(评估性质)。
- 长事务保护:`useSceneHistoryState.ts` 仅 220ms 防抖计时,无事务窗口时长上限/超时自动提交告警 → **仍缺**。
- 崩溃草稿与事务粒度重放:现有恢复草稿(sceneRouteRecovery/本地延迟写)是场景级,非"恢复副本按事务粒度重放" → **仍缺**。

**新拆任务行**:

| 任务行 | 范围 | 文件 | 估时 | 依赖 |
|---|---|---|---|---|
| T27-A | 事务标签 UI(撤销菜单分组+N/M 提示)+ 长事务窗口上限/超时自动提交 | useSceneHistoryActions/State、Topbar | 4–8h | 高信心;需浏览器视觉闭环 |
| T27-B | 低频域记账评估(动画设置/工程分析)+ 崩溃草稿按事务粒度重放 | hooks/controllers | 4–8h | 中信心 |

## 8. T28 —— 物理可视化调试器(PhysicsDebugPanel)

**已覆盖**:
- 首切片全量交付并随 `7bdb73e0` 入库:步进/录制/回放/刚体/关节/跨端位姿比对(T17 格式导入)/导出,47 新测 + 两轮浏览器视觉闭环。
- wasm 位姿查询基元:`packages/deep-engine-wasm/src/physics_pose.rs`("查询物理实例最近提交固定步后的位姿")已随 `7bdb73e0` 入库并构建进 `dist/engine-wasm`(d.ts 可见 `viewer_physics_pose`)。

**仍缺**:
- 在线逐步比对桥:wasm `viewer_physics_pose` 无任何 TS 消费方(仅 dist 声明);web `PhysicsDebugPanel` 槽 B 仍走"导出 JSON→手动导入"离线路径,Native/WASM 运行时逐帧流→面板在线比对未接 → **仍缺**。
- 通用数值容差冻结:报告明示属 T17 遗留 → **归属他项(T17 行)**。

**新拆任务行**:

| 任务行 | 范围 | 文件 | 估时 | 依赖 |
|---|---|---|---|---|
| T28-A | 在线逐步比对桥:消费 wasm/native 位姿流,面板槽 B 实时填充/逐帧比对 | deep-engine-wasm 消费端、PhysicsDebugPanel | 4–8h | 依赖 native 查询面稳定性;中信心 |

## 9. T29 —— 空间音频(audio director/viewer/native dashboard_audio)

**已覆盖**:web 最小集(衰减公式唯一权威/告警启停规则 ISA-18.2/合成双音告警/OfflineAudioContext 离线渲染/双层泄漏证明)随 `7bdb73e0` 入库,49 测 + gate:spatial-audio 门。

**仍缺**(grep 证据):
- 宿主挂载:`viewerEngineInteraction.ts` 的 `action==="alarm"` 分支与 alert-state 轮询均无 `startAlertOverride`/`AlertAudioDirector` 引用(director 仅被 src/audio 内部测试消费) → **仍缺**(报告称一行级接线)。
- ambient 合同:contracts 无 `SceneAmbientAudioState`/ambientAudio 命中 → **仍缺**。
- Native/WASM 3D 声与混音总线:`dashboard_audio.rs` 头注明示"Scope is deliberately one MP4 audio track… Spatial audio and multi-voice mixing stay out";09-23~09-25 后未再动 → **仍缺**。
- 多声源混音/告警穿透静音/escalation restart:无实现 → **仍缺**(与混音总线同批或条件触发)。
- 真实设备声样本:属样本采集授权事项,维持合成波形替代 → **归属条件项**(样本入库纪律),不计当前净工时。

**新拆任务行**:

| 任务行 | 范围 | 文件 | 估时 | 依赖 |
|---|---|---|---|---|
| T29-A | 告警宿主挂载(alarm 分支+轮询差分→director) | viewerEngineInteraction/App | 2–4h | 高信心 |
| T29-B | ambient 合同扩展 + 环境声消费 | contracts + viewer | 4–8h | 中信心 |
| T29-C | Native 混音总线 + 3D 告警定位(dashboard_audio 扩展或新模块) | native audio | 12–24h | 低信心;建议按真实需求触发 |

## 10. T30 —— 受限 Play 模式(useScenePlayMode/Native/WASM hosts)

**已覆盖**:
- Web App 生产入口/恢复:顶栏 Play 按钮、播放态门禁(undo/redo/保存/自动保存)、恢复失败保留快照、P1 严格完成语义(报告 §八/§九);I-C25 增量恢复(`cb387b50`+`52d3c74a`);Play 恢复重试门(`fb8f79d4`);播放头恢复(`e1261af7`,10-01)→ Web 侧进入/恢复/增量恢复链条完整,任务提示"Web App 已做"属实。

**仍缺**(grep 证据):
- Native/WASM Play 语义:`deep-engine-native/src/app/mod.rs` 无 play/playMode 语义;`deep-engine-wasm` 无对应导出 → **仍缺**。
- WebGPU Play 仍显式禁用:`AppWorkspaceTopbar.tsx:211-213` "Play 暂不支持 WebGPU,请先切换 WebGL" → **仍缺**(解禁评估或正式裁决)。
- 参数/行为 IR 热应用:无实现;`hotReloadTypes.ts` 是 WGSL 着色器热重载(不同域);G2 设计稿(`445af695`)把"热重载语义(Play 中不热换)"列为真实缺口待用户评审 → **设计归属他项(G2),实现仍缺**。
- 播放会话遥测(进入/退出/恢复失败计数)接 T25:无命中 → **仍缺**(小)。

**新拆任务行**:

| 任务行 | 范围 | 文件 | 估时 | 依赖 |
|---|---|---|---|---|
| T30-A | WebGPU Play 解禁评估/裁决与实现或正式范围关闭 | App/Topbar/persistence | 2–4h | 中信心 |
| T30-B | Native/WASM Play 语义对齐(进入/隔离/恢复) | native app/wasm | 8–16h | 低信心 |
| T30-C | 播放会话遥测接 T25 面板 | web | 2–4h | 高信心 |
| — | 热应用语义 | — | 归属 G2-S2b/S2d 设计与实现 | 不重复计时 |

## 11. T31 —— 受限行为脚本与图(restrictedCommandAdapter/behaviorTraceLog)

**已覆盖**(任务提示三条全部证实):
- 命令适配器:`apps/web/src/scripting/restrictedCommandAdapter.ts`(经 scene-sdk `parseSceneCommand`+`SceneCommandExecutor` 执行,含 audio 端口),随 `1e07cdaf` 入库。
- Play 接线:`restrictedPlayConsumer.ts`(结构兼容 T30 active 信号)同批入库。
- 文档持久化:`restrictedInteractionDocument.ts`——受限图以 `/* @bim-studio/restricted-graph/v1 */` 前缀存入既有 `interaction.code` 字段(fail-closed,永不回退为可信 JS),免合同变更;`BehaviorGraphEditor/View/NodeForm`(G2-S2a)在库。
- Native 行为 IR(部分):`packages/deep-engine-native/src/behavior_ir.rs`(09-16 `85a15789` 已入库,N0 受限命令总线:封闭枚举/两阶段提交/幂等/CAS/取消/预算/能力门控)→ 命令通道域**已有**。

**仍缺**:
- 点键表达式与字符串转义:`restrictedEvaluator.ts` 无点键/转义支持(报告 §九.4 声明的盲区仍在) → **仍缺**。
- TS↔Native 求值通道:web 求值器为 TS 纯逻辑,native `behavior_ir` 是命令总线无表达式求值;两者未桥接 → **仍缺**(建议按真实跨端行为需求触发)。
- 轨迹日志 UI 面板(E3 消费面/审计回放视图):web 组件无 behaviorTrace 消费 → **归属他项(G2-S2b/S2d**,权威表 G 组"轨迹回放 UI"行),不重复计时。

**新拆任务行**:

| 任务行 | 范围 | 文件 | 估时 | 依赖 |
|---|---|---|---|---|
| T31-A | 点键表达式支持(转义或嵌套命名空间)+ 字符串转义序列 | restrictedEvaluator(+graph 校验) | 2–4h | 中信心 |
| T31-B(条件) | TS↔Native 求值通道贯通 | native behavior_ir/web | 8–16h | 按跨端行为需求触发 |

## 12. T32 —— 引擎内 ONNX 推理网关(onnxInferenceGateway/vision)

**已覆盖**:
- CPU 参考网关本体:`onnxInferenceGateway.ts`(376 行,22 项边界)+`onnxSessionProviders.ts`+`onnxGatewayTrendForecast.ts`(库级非 battery 消费链),35 测,`7bdb73e0` 入库;
- battery 薄壳化(两处单行委托,13 文件 51 测零回归)。

**仍缺**(grep 证据):
- 组合根产品接线:`industrialCapabilities.ts`/`index.ts` 无网关消费方;趋势预测链未接 T24 数据源(onnxGatewayTrendForecast 仅被自身测试消费) → **仍缺**。
- 非 battery 批准模型:`apps/api/models/` 仅 `battery/`;无第二个经"清单+SHA-256+目录边界"批准的模型 → **仍缺**(依赖模型资产到位)。
- GPU EP 逐模型黄金:`onnxSessionProviders.ts` 无 golden;跨 EP 数值不等已实测(CPU/DML/WebGPU 三值互异)——黄金校验未建 → **仍缺**。
- vision 薄迁移:`vision.ts` 仍自建会话(`visionSessionOptions("cpu"/"directml")`),未走网关 → **仍缺**。
- 并发配额/优先级:权威表已列为观察项"H远期/T32配额"(真实争用后再加) → **归属他项**,不重复计时。

**新拆任务行**:

| 任务行 | 范围 | 文件 | 估时 | 依赖 |
|---|---|---|---|---|
| T32-A | 组合根共享网关实例 + 受控推理入口 + 趋势预测接 T24 数据源 | api 组合根 | 4–8h | 高信心 |
| T32-B | 首个非 battery 批准模型注册(缺陷检测/预测性维护) | models+清单体系 | 4–8h | 依赖模型资产 |
| T32-C | GPU EP 逐模型黄金值校验(DML 微型图异常单独排查) | providers+脚本 | 6–12h | 中信心;真机 |
| T32-D | vision 域薄迁移到网关(保留输出解析在域) | vision.ts/visionRuntime.ts | 4–8h | 中信心 |

---

## 汇总

| 组 | 结论 | 说明 |
|---|---|---|
| T19 | **仍缺** | 7 尾项零覆盖;拆 T19-A/B(18–36h) |
| T20 | **仍缺**(I-C17 已排除) | 排序/事件读回/LUT/火焰接线/烟体全缺;拆 T20-A/B/C(24–48h) |
| T21 | **部分已覆盖** | 10 万行/IME/文本矩阵已交付;2D 骨骼/2D 物理/UIA 跨层/触控/动作映射仍缺;拆 T21-A/B/C(19–38h) |
| T22 | **主体已覆盖/已冻结** | 8.x 与纹理追索冻结;X_T 生产 profile(revolved subset+通用档)已闭合;PMI 语义条件触发;X_T 装配/材质语义拆 T22-A(4–8h) |
| T23 | **部分已覆盖** | localeCompare 清剿已完成;告警回放链/谱系/数据质量/案例库仍缺;拆 T23-A~E(21–42h;D2-gradient 归属他项) |
| T24 | **主体已覆盖** | 持久订阅+文件 checkpoint 完成;SubscriptionTransfer/backfill/证书/质量可视化仍缺;拆 T24-A~D(18–36h) |
| T27 | **主体已覆盖** | 事务/动画入账/Play 隔离/播放头恢复完成;标签 UI/长事务/低频域/崩溃草稿仍缺;拆 T27-A/B(8–16h) |
| T28 | **主体已覆盖** | 面板+录制/回放/比对交付;wasm 位姿基元在库;在线逐步桥仍缺;拆 T28-A(4–8h);容差冻结归 T17 |
| T29 | **部分已覆盖** | web 最小集交付;宿主挂载/ambient/Native 混音仍缺;拆 T29-A/B/C(18–36h) |
| T30 | **Web 侧已覆盖** | Native/WASM Play/WebGPU 解禁/会话遥测仍缺;热应用设计归 G2;拆 T30-A/B/C(12–24h) |
| T31 | **命令适配/接线/持久化已覆盖** | 点键表达式仍缺;Native 命令 IR 已有(N0),求值桥条件触发;轨迹 UI 归 G2;拆 T31-A(+B 条件)(2–4h,+8–16h) |
| T32 | **CPU 网关已覆盖** | 产品接线/非 battery 模型/GPU EP 黄金/vision 迁移仍缺;配额归观察项;拆 T32-A~D(18–36h) |

**新拆任务行合计:约 31 行,170–336h**(含 2 行条件触发:T22-B PMI、T31-B 求值桥;手柄动作映射 U1、T32 配额、T23-gradient、热应用设计、T28 容差冻结、真实音频样本等均归属他项,未重复计时)。

**无法确认项**(诚实条款):T20 实机预算档阶梯、T28 桥接后在线逐帧稳定性、T30-B Native Play 的具体宿主接口形态、T22 PMI 真实样本可得性——均需实现切片内的实测证据,本核查无法凭静态源码断言。

## 证据入口

- T 报告:`docs/reports/deep-core/T19/T20/T21/T22/T23/T24/T27/T28/T29/T30/T31/T32-implementation.md`。
- 关键提交:`7bdb73e0`(09-28 多线收口)、`1e07cdaf`(09-28 能力线接线)、`cb387b50`/`52d3c74a`/`fb8f79d4`(09-30 Play 恢复)、`5b89aca6`/`43fdb735`(09-30 I-C17)、`e1261af7`(10-01 播放头恢复)、`37c98eab`(10-01 时钟注入)。
- 权威边界文档:`docs/format-support.md`、`docs/builtin-profiles.md`、`docs/specs/industrial-3d-format-work-plan-2026-09-16.md`、`docs/specs/i-c17-production-particle-flow-20260930.md`。
- 源码锚点:`packages/deep-engine-native/src/runtime_navigation_crowd.rs:39`(T19 尾项自述)、`apps/api/src/opcUaSubscriptionSource.ts:521`(T24 未实现声明)、`apps/web/src/views/AppWorkspaceTopbar.tsx:211`(T30 WebGPU 禁用)、`packages/deep-engine-native/src/dashboard_audio.rs:1-4`(T29 Native 边界)、`packages/deep-engine/src/textOrder.ts`(T23 清剿)。
