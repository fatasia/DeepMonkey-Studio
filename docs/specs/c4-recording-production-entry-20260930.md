# C4 事件录制生产入口

用户在运行监控中建立录制、写入注入或仿真事件、关闭和重开历史段，按工业时间、源序或已声明的帧映射检查事件，并导出附录制引用的 Study 只读证据副本。

## 现状核查

1. 全仓 `packages/**/src`、`apps/**/src` 及 `git status --short`：已有 contracts/eventRecording、API EventRecordingSession/FileStore/routes/tests；未跟踪文件属于其他并行任务，无第二套录制设施。
2. 契约：已有 EventRecordingFile/Assessment/ResumeOrigin、事件/缺口/乱序/接缝、三轴筛选、attachRecordingEvidence；全部复用。
3. 依赖：Fastify、React、contracts、Vitest 和 browserDownload 已在用；无新增依赖。
4. 消费方：dataEvents 通过 recording 依赖条件注册；生产 index 尚未启用。OperationsCenter monitoring 已消费告警与短窗回放，但没有持久录制入口。DataEvent 没有工业源序，不能把 bus 最近 200 条当完整工业记录。
5. 测试与证据：contracts/API 已覆盖完整性、断序、未知序、跨会话重开；新增检查生产组合挂载、磁盘重读、用户筛选与证据副本。N11 checkpoint 已启用，不重建。
6. 规格：按 gpt-handoff-20260930、remaining-tasks-estimates-20260930 的 C4-recording 校准；原点化与物理位姿录制属于其他已交付能力。

**已有（不重建）**：持久文件录制、checkpoint/store、来源与序列合同、三轴纯函数、Study 只读投影、短窗告警回放。

**真实缺口**：生产条件路由未开启；录制/历史重读/手工重开/完整性和三轴检查/Study 证据没有用户入口。

## 本轮范围

- 生产组合函数启用既有 routes，返回同一 DataEventBus 供 MQTT/告警/checkpoint 原消费者继续使用。
- 运行监控新增独立录制面板；明确区分注入/仿真，用户自带的 source sequence 保真，空序保持未知。
- 重开显式填写恢复出处 connectionId、generation、lastSequence/lastTimestamp；不自动编造 checkpoint。
- 读取端重算 assessment；缺口/乱序/接缝与源序未知直接显示，帧映射未声明时禁用帧轴。
- Study 通过既有 attachRecordingEvidence 导出只读副本和录制文件，不修改权威 Study、不建立第二账本。

后继：有源序的订阅 runtime 自动录制与吞吐优化；本轮不把 bus/MQTT 到达序伪装成源序。既有单文件逐事件重写和 20,000 条显式上限保持。

## 设计与验证

对标西门子 PS/PD/Plant 工业信息严谨性；主事件表、渐进展开输入、base.css 令牌与双主题。设计依据：`C:/Users/rain/.agents/skills/design-taste-digitaltwin/SKILL.md` 第 1、7、9 节；本轮为运行记录入口，3D 画质不在范围。

### 结果

- API focused：productionDataEvents、eventRecordingRoutes、eventRecording 共 16 项通过；包含真实生产组合、磁盘重读、保留历史段、gap/out-of-order/seam 和原 DataEventBus 消费。
- Web focused：panel/model/OperationsStudyHistory 共 9 项通过；跨项目、坏结构、坏指纹、源序未知、帧轴未声明、反向范围、未知路由字段拒绝与不可变 Study 副本。
- API 和最终 Web tsc 通过；并行 `compileSceneDisplayProfile.test.ts` 的 exactOptionalPropertyTypes 暂态已由拥有者修复，未放宽合同。diff-check 通过。
- 专项真实产品 CI `apps/web/scripts/gate-event-recording-flow.mjs` 两轮通过：实际登录→项目→智能运营/现场监控→新录制→序 1/3/2→关闭→浏览器重载→历史读回→手工重开→无源序事件→工业时间/源序/帧轴筛选→真实 DES Study 证据副本导出。
- 两轮各为 3 个事件、1 个已知缺口、1 个拒绝乱序、1 个接缝、2 个录制段；无源序事件保持 sequenceAssigned=true/sourceSequenceKnown=false。源序筛选只显示 1/3，帧 1 显示首条事件；工业时间窗口由实际录制原点确定。
- 最新证据 `test-output/c4-recording/report.json` 为 passed，记录生产消费源码的 SHA-256；截图 `r1/r2-01…06` 覆盖 1280/480、深浅主题，另有 `04/05-…-header.png` 保留既有 sticky 导航下的真实面板标题。480 面板 450/450 px，页面 480/480 px，无横溢。两份 `r1/r2-study-evidence.json` 的引用指向各轮真实录制指纹。

### 两轮视觉复检与同族排查

真实浏览器首轮发现关闭请求带 JSON header 却无请求体，被 Fastify 拒绝；已改为仅在有 body 时设置 JSON header，并复跑完整流。截图发现缺口结论配绿色勾会混淆“指纹有效”与“连续”，已改为警告图标/语义色；同族 open-unknown 同样使用警告。浅色主题截图等待 reduced-motion 的稳定状态，避免把换主题中的中间色当最终颜色。全部变量在 base.css 存在，未增全局令牌。

| 维度 | 评分 | 实测依据 |
|---|---|---|
| 布局构图 | 9 | 全宽事件表、折叠输入、两轮桌面/窄屏；标题另有真实 viewport 截图 |
| 令牌一致性 | 9 | base.css 令牌；深浅主题、warning/accent 派生 |
| 排版 | 9 | 表格等宽数字；工业时间本地化；窄屏长来源换行 |
| 交互状态 | 9 | 实际 empty/pending/success；模型拒绝坏输入与证据；closed 按钮禁用并解释 |
| 动效 | 9 | 160ms 操作反馈；CI reduced-motion 实际启用 |
| 3D 渲染 | 不适用 | 本轮是持久记录入口 |
| 信息设计 | 9 | 事件/缺口/乱序/接缝区分，源序和到达序区分 |
| 即时反馈 | 9 | 操作立即 pending，写入/导出确认、异常重读核对 |
| 响应式与主题 | 9 | 1280/480、dark/light 两轮，面板/页面均无横溢 |
| 语义文案 | 9 | 来源明确；未声明帧映射禁用；Study 副本与权威记录区分 |

### 交付边界

已接线注入/仿真事件的持久录制与只读复盘入口。订阅自动录制、源 checkpoint 自动接缝、高吞吐分段存储、向设备重发事件、跨进程写入并发治理、桌面 Local API 录制适配保留后继；Study 仅导出附引用的只读副本。当前 API 单文件重写/20,000 条上限沿用已有实现。

CI 运行前显式设置 `METADATA_STORE=json`、`OBJECT_STORE=local` 和独立 DATA_DIR，避免既有 SQLITE_DATABASE 落到另一个目录。专项脚本要求 `C4_RECORDING_TEST_SERVER=isolated`，服务生命周期由调用方管理；账号 token/密码不写入报告。

后续视觉验证按用户最新长期指令仅做深色 1920×1080，两轮覆盖必要的改动流程；本轮已经生成的深浅/窄屏证据保留，不重复运行矩阵。
