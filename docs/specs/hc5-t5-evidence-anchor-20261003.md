# H-C5-T5：逐条引用与真正证据锚对齐（2026-10-03）

行定义（`docs/specs/remaining-tasks-estimates-20260930.md:158`）：「逐条引用与真正证据锚对齐，
复用 K1 校验器和现有指纹载体」（6–12h）。依赖：chatEvidenceGate；H-C4-P2。

## 现状核查（六步前置，2026-10-03 执行）

### 1. 全仓 grep（apps/api/src、apps/web/src，含未跟踪）

- `chatEvidenceGate`：仅 `apps/api/src/ai/chatEvidenceGate.ts` + 其测试 + `assistantService.ts:336`
  一个消费点。K1（P0「chat 只读证据环」后置校验器，K2 并入，见
  `docs/reports/AI助手交互与可靠性深度审计-20260929.md:144`）**已落地**：
  `auditChatAnswerEvidence(answer, sentContext)` 抽取数值/编号 token 与真正发送前缀逐项
  includes 比对，产出 flat `matched[]/unmatched[]`；未命中→逐条警示+`verification→limited`，
  命中→`contextTrust=server-evidence`。
- `H-C4-P2`（证据指纹进 contextDelivery）**已落地**：`assistantContextDelivery.ts` 以属性
  序列化计算每来源在 prepared JSON 串内的 utf16 `start/text`，产出 per-source
  `{id,path,status,preparedChars,sentChars,transformed}`；web `readContextDelivery` →
  `AiContextDeliveryEvidence` 渲染；session 路由 `contextDeliveryInput` 白名单持久化。
- `citation/引用锚/脚注`：web/api/contracts **全零命中**——逐条引用锚不存在。
- 指纹载体：`aiReliabilityAudit.ts` `auditFingerprint(canonical→sha256)`（`contextFingerprint`
  同源）；`evidenceFingerprint/contentFingerprint` 家族遍布 contracts（battery/askData/
  operations/provenance 等）。
- 未跟踪/未提交改动归属：`assistantPrompts.ts`（hc6s2 lessons 教学文案，已完成线）、
  `runAssistantRequest.ts`（T1 当日已完成）、`assistantService.test.ts`（+1 行）——均非活跃
  冲突面；`chatEvidenceGate.ts`、`assistantService.ts`、`assistantContextDelivery.ts` 工作区无未提交改动。

### 2. 契约层

- `AiAssistantReliability`（`packages/contracts/src/index.ts:215`）：有 `contextDelivery/
  contextFingerprint/evidenceCount/warnings`，**无逐条引用字段**；`evidenceCount` 在 chat 路径
  恒 0（语义=Capability 执行证据数，chat 无能力执行，语义正确，不动）。
- `AiSessionReliability`（`aiSession.ts`）：同形白名单结构，无 citations。

### 3. 依赖

零新依赖：复用 `@bim-studio/contracts`、`node:crypto`（经 `auditFingerprint`）、既有
`locate()/SOURCE_PATHS`。禁 cargo（无 Rust 面）、禁帧时测量（无渲染路径）——均不适用。

### 4. 消费方（实际链路）

- 服务端：`assistantService.withReliability`（complete+stream 两路）→ `reliability.citations`
  新挂点；`assistantSessionRoutes.reliabilityInput` 白名单重建对象——**新字段不进白名单即静默
  丢弃**（session 刷新丢锚）。
- web 保存/恢复链**原样透传**：`useAssistantChatRun.finish` 把
  `AssistantReliabilitySummary` 整体写入 `saved.writer.update`，`useAssistantSessions` 恢复时
  原样挂回 `AssistantConversationItem.reliability`（该类型即 `AssistantReliabilitySummary`，
  定义在禁碰文件 `AiAssistantMessages.tsx` 中但无需改动）→ **加字段即全链生效，禁碰文件零改动**。
- 渲染位：`AiResponseEvidence.tsx`（证据面板，未被禁碰清单覆盖；`AiAssistantMessages.tsx`
  只 import 它，禁碰文件零改动）。

### 5. 测试与证据

- `chatEvidenceGate.test.ts`（K2 回归锁 6 用例）；`assistantService.test.ts`；`assistantSessionRoutes.test.ts`；
  web `assistantReliability.test.ts` 存在；`AiResponseEvidence.tsx` **无独立测试**（靠
  `AiAssistantMessages.test.tsx` 间接覆盖）——本次新建其直测。

### 6. 核查结论：已有（不重建） vs 真实缺口

**已有（不重建）：**

- K1/K2 校验器（token 抽取+出域比对+降级语义）——保留原语义零变更；
- H-C4-P2 证据锚坐标系（contextDelivery 的 utf16 偏移体系+sentChars 语义）；
- 指纹载体（`auditFingerprint` sha256，与 contextFingerprint 同族单一事实来源）；
- web 保存/恢复/渲染三段载体（透传即生效）。

**真实缺口（本行动手面）：**

1. **对齐表不存在**：校验器只答「token 是否命中」，不答「来自哪个来源、在源内何处、源指纹是
   什么」——长回答具体数字无法对应到具体来源（审计 T5 原文）。
2. **发送边界未核**：K2 对 80k 前缀整体 includes——部分发送来源的**尾部内容模型从未见过**，
   据此出引用即伪引用；真锚必须 `pos+len ≤ 该源已发送长度`。
3. **合同与持久化无载体**：`citations` 字段缺失，session 白名单会丢弃。

修复口径（缺哪段补哪段）：契约加法演进 → 服务端锚定函数（复用 token 抽取与 locate 坐标系）
→ withReliability 挂载 → session 白名单 → web 透传+证据面板逐条引用清单 → 双侧测试。

（实现与证据见下节，完成一节写一节。）

## 实现（六段全链，2026-10-03）

1. **契约**（`packages/contracts/src/index.ts` + `aiSession.ts`，加法演进）：
   新增 `AiAssistantCitation { token; anchors: [{ sourceId; sourcePath; offset; fingerprint }] }`；
   `AiAssistantReliability` 与 `AiSessionReliability` 各增可选 `citations?`。缺省=无锚，旧客户端零影响。
2. **证据定位输入**（`assistantContextDelivery.ts`）：导出 `assistantContextSourceSegments(prepared)`——
   与 `assistantContextDelivery` 同一 `locate()/SOURCE_PATHS`、同一次序列化口径，产出
   `{id,path,start,text}` 段清单。**零新机制**：锚坐标系与 contextDelivery 逐字节一致（H-C4-P2 载体复用）。
3. **锚定函数**（`chatEvidenceGate.ts` `anchorChatAnswerEvidence(answer, sources)`）：与 K2 同源
   token 抽取（复用 `collectTokens`，同 24 上限），逐来源在**已发送窗口内**定位首次出现；
   铁律=锚点尾沿 ≤ 该来源已发送长度（部分发送来源的尾部模型从未见过，据此出引用即伪引用，
   一律不产出）；千分位变体同 K2；来源指纹直接调 `auditFingerprint`（sha256，与 contextFingerprint
   同一载体单一事实来源，不复制算法）。对不上任何来源的 token 不进 citations——仍由 K2 warnings
   通道如实披露，两通道互补不互替（K2 宽松比对定 trust/降级；T5 严格窗口约束定引用清单）。
4. **服务端接线**（`assistantService.ts`）：`prepareRequest` 由交付回执逐源 `sentChars` 合成
   `citationSources`；`withReliability`（complete+stream 两路共用）产出 `citations` 挂入
   `reliability`（空数组不挂字段）。K2 既有警示/降级语义零变更。
5. **session 持久化**（`assistantSessionRoutes.ts`）：`reliabilityInput` 白名单增加 `citations` →
   `citationsInput` 校验（≤24 条 × ≤16 锚，offset 非负 safe-int，fingerprint ≤128 字符）——
   白名单外字段本会被静默丢弃（刷新丢锚），此为持久化缺口的唯一补点。
6. **web 透传+渲染**：`assistantReliability.ts` `readCitations` 防御性过滤（形状不对的条目丢弃，
   前端绝不自造锚）后挂入 summary——保存/恢复链（`useAssistantChatRun`/`useAssistantSessions`/
   `assistantSessionApi`）整体透传 reliability，**禁碰文件零改动全链生效**。
   `AiResponseEvidence.tsx` 新增「逐条引用（回答数值 ↔ 已发送证据）」dl 清单：每行 = token（dt
   等宽码）+ 来源标签 + 源内偏移 `@n` + 可复制来源指纹；来源标签回退与 AiContextDeliveryEvidence
   同族（用户标签 → 目录/BIM 证据/路径）；title 悬浮披露路径+指纹全文。样式并入
   `AiAssistantReliability.css`（行网格/复制钮复用面板既有作用域）。

**实现期修复的真实缺陷（测试抓出）**：锚内复制钮初版复用 `EvidenceCopyValue`（返回 `<dd>`），
渲染出 `<span>` 内嵌 `<dd>` 的无效 HTML——重构为 `EvidenceCopyValue` = dd 包装 + 裸
`EvidenceCopyButton`，锚内用裸钮，复制逻辑单份不复制；CSS 选择器由 `dd .ai-evidence-copy`
放宽为面板作用域 `.ai-evidence-copy`（T4 主行行为零变化）。

## 测试与证据（2026-10-03 实测）

| 门 | 结果 |
|---|---|
| `packages/contracts` build（dist 供 NodeNext types 条件） | 通过 |
| `packages/contracts` 全量 vitest | 50 文件 / **464 passed** |
| apps/api `tsc --noEmit` | **0 错误（exit 0）** |
| apps/api ai 域全量 `vitest run src/ai/` | 49 文件 / **364 passed** / 0 failed |
| `chatEvidenceGate.test.ts`（K2 回归 6 例 + 新增 T5 锚定 4 例） | 10/10 |
| `assistantService.test.ts`（含新增 T5 端到端 2 例：真实锚对齐 / 截断尾部零伪锚） | 20/20 |
| `assistantSessionRoutes.test.ts`（含新增 citations 往返 + 3 形状非法 400） | 6/6 |
| apps/web ai 域全量 `vitest run src/ai/` | 22 文件 / **130 passed** |
| web 证据面板族（ResponseEvidence 新建 2 例 + ContextDelivery + Messages + Panel 回归） | 5 文件 / **37 passed** |
| `assistantReliability.test.ts`（含新增 citations 透传/坏形状丢弃） | 6/6 |
| apps/web `tsc --noEmit` | 本刀文件 0 错误（余 3 错误均他线未提交改动，见诚实条款） |

## 同族排查结论

- **sql 问数/Capability 路径**（`queryCapabilityReliability`）：证据载体是 evidenceCount+
  evidenceFingerprint（Capability 执行证据），不存在"回答文本↔快照"对齐问题，刻意不挂
  citations——证据族边界保持，不混写。
- **harness/agent 决策链**：走 AiVerificationEnvelope + provenance 三跳账本（resultFingerprint），
  是另一族证据体系（C 线纪律：行动回执≠仿真判定），不动。
- **可靠性白名单第二实现排查**：api 侧 `reliabilityInput` 是唯一持久化白名单（grep 全仓确认），
  citations 单点补齐；无第二套校验。
- **`dd` 嵌套缺陷同族**：全组件 grep 无第二处 span/p 内嵌 dd；新缺陷单点修复。
- **标签回退小重复**（citationSourceLabel 与 AiContextDeliveryEvidence 各 12 行）：抽公共需跨
  组件耦合，两处同族小函数在容忍内，如实记录不硬抽。

## 诚实条款

- **未过浏览器视觉闭环**：浏览器由 E2/Z4 独占（硬约束），本刀 UI 改动（逐条引用清单）仅过
  renderToStaticMarkup 断言（标签/偏移/指纹/aria-label/合法嵌套）+ 现有 37 例组件回归；
  视觉密度与换行表现未实测，风险已列。
- apps/web 全量 5491 测试套件未跑（本刀 web 侧改 3 文件+2 测试文件；已覆盖 ai 域 130 +
  面板族 37 + tsc），如需全量可后补。
- apps/web `tsc` 存在 3 个**他线未提交改动**引入的错误（`packages/deep-engine/src/gltf/
  optionalMaterialFallback.ts`、`apps/web/src/behavior/SceneCommandExecutor.test.ts`、
  `ViewerSceneCommandPort.test.ts`——H-C7-P3/DE 域半成品），非本刀引入，未修不碰。
- web 保存链端到端（PUT /messages 带 citations → 重启恢复）由 api 侧路由测试锁死；浏览器内
  刷新恢复的 UI 表现未实测（同浏览器占用约束）。
- 未 commit/push（硬约束遵守）；contracts dist 已重建（工作区共享产物，未提交）。
- 禁 cargo/禁帧时测量不适用（本刀无 Rust 面、无渲染帧路径；锚定成本为 24 token × ≤16 源的
  indexOf，服务端毫秒级以下，未单测计时）。
