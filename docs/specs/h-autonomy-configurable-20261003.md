# H-autonomy：授权范围/执行模式可配置（2026-10-03）

行定义（remaining-tasks-estimates-20260930.md:149）：授权范围/执行模式可配置，已授权修改自主执行，
取消/回滚/审计继续有效；通用开发模式按授权发现已注册工具，专业脚本不逐条审批。依赖：ontologyAction/agent
网关/权限合同。估时 6–12h。jc-i-continuation-20261001.md:644 将本行列为"可做"。

## 一、现状核查（六步，2026-10-03 完成）

1. **全仓 grep**（`executionMode|autoApprove|agent-settings|AgentAutonomy|autonomy`，apps/packages src）：
   零命中——授权范围/执行模式**没有任何可配置面**。`git status` 未跟踪文件无相关产出（无他线在建）。
   现行审批面：
   - `industrialAgentToolGateway.toDefinition`（:164）`requiresApproval = risk === "high"` **硬编码**；
   - orchestrator `applyDecision`（:328）`requiresApproval → pendingTool.state = "awaiting-approval"`
     → run 停 `awaiting-approval` 等人 `POST /approve`（scopeFingerprint 必须与工具参数指纹全等，
     `aiToolReliability.validateApproval` 另有 15 分钟时效硬校验）；
   - 发现面 `CURATED_TOOL_IDS`（网关 :16-37）20 个策划工具硬过滤；注册表里还存在未入环的能力
     （`data.query.draft`、`modeling.parametric.draft` 等），通用开发模式下按授权可见。
2. **契约层**：contracts 无 agent 自治类型；`DatabaseDocument.aiSettings`（全局设置持久化先例）、
   orchestrator `AgentCheckpoint.planMode`（run 级模式持久化先例）、`AgentGuardState`（checkpoint 状态
   随恢复语义持久化先例）均已存在 → 本行按同构扩展，不新建机制。
3. **依赖**：无需新增依赖。orchestrator 包零外部依赖，保持（模式联合类型在包内定义，API 层做适配映射）。
4. **消费方**：网关被 `industrialAgentRuntime` 与 ontologyActionService（H-C4-P3 三跳链）共用；
   orchestrator 被 runtime + routes 消费；web 侧 `IndustrialAgentWorkspace`（start/运行视图）、
   `SceneBehaviorAgentWorkspace`、`industrialAgentApi.ts` 消费。改动必须向后兼容这些消费方。
5. **测试与证据**：`orchestrator.test.ts`(9 it)、`industrialAgentToolGateway.test.ts`、
   `industrialAgentRoutes.test.ts`(6 it)、`agentHarnessIntegration.test.ts`(6 it)、
   `IndustrialAgentWorkspace.test.tsx` 均在；本行新增测试落在同域。
6. **规格**：H-C2 保安（`agentHarnessGuards.ts`：pre-execute 语义预检 / post-execute verdict 回灌 +
   审计钩子）与 H-C1 plan 档（网关硬拒 + 决策面收敛双防线）已提交（b6bb2e00/2e40732a 一线）；
   取消链 `orchestrator.cancel` + 路由 DELETE + `AiHarnessDenialCard` 在位。`jc-i-continuation-20261001.md`
   按要求只读。

**结论**：四要素全部为真实缺口（无配置面、无自主执行、审计不含审批来源、发现面写死）；
已有且必须沿用不重建：审批指纹纪律、`executeReliableAiTool` 硬防线、guards 挂载点、取消/恢复链、
plan 档双防线、`DatabaseDocument` 设置持久化模式。

## 二、四要素设计与落点

| 要素 | 落点 |
|---|---|
| ① 授权范围/执行模式可配置 | contracts `AgentAutonomySettings`；`DatabaseDocument.agentSettings` 全局持久化（store get/save）；`GET/PUT /api/projects/:projectId/ai/agent-settings`；run 启动可带 `executionMode` 覆盖（服务端校验，持久化进 checkpoint 随恢复语义走）；UI 挂工作台 start 面板模式行（不新增大页） |
| ② 已授权修改自主执行 | orchestrator `applyDecision`：run 的 autonomy.mode=autonomous 且工具在授权 autoApprove 范围（settings.autoApproveToolIds，空=授权面全量）时直接 `state:"ready"`，并挂**策略签发的 AgentApproval**（approvedBy=`autonomy-policy`，scopeFingerprint=调用指纹）——下游 `validateApproval` 硬防线照常校验指纹与时效，防线不降级 |
| ③ 取消/回滚/审计继续有效 | guards pre/post-execute 挂载点不动；`executeReliableAiTool` denied/allowed/completed 审计事件不动；`AgentToolRecord` 新增可选 `approval` 字段把"谁批的"（人 or `autonomy-policy`）落进 checkpoint 持久审计；取消链（DELETE /agent-runs/:id → AbortController）在自主模式照常；写入/控制完成后验证证据强制不变 |
| ④ 通用开发模式按授权发现 | `AgentToolGateway.list(mode?)` 增加可选 discovery 参数（缺省 curated=现状）；`AgentCheckpoint.discovery` 持久化；`GET agent-tools?discovery=general` 受 settings.generalDevelopment 开关门控（关闭→400 理由码 `general-development-disabled`，fail-closed）；general 面仍受 run 级 allowedToolIds 授权收口 + settings.generalDevelopmentDeniedToolIds 显式排除；专业脚本（策划环工具）在自主模式下不逐条审批（即要素②） |

安全红线（全部保持）：无动态命令/shell/文件工具（发现面仍只出 PluginRegistry 已注册 capability）；
plan 档优先级最高（autonomous 不绕过）；角色线 viewer 不可启动/审批/取消/改设置；
`tools.execute` 白名单硬拒不因 discovery 放松（general 只是把面从策划清单放宽到注册表）。

## 三、实现记录（2026-10-03 完成）

### 契约层
- `packages/contracts/src/agentAutonomy.ts`（新）：`AgentExecutionMode`（confirm|autonomous）、
  `AgentDiscoveryMode`（curated|general）、`AgentAutonomySettings`（mode / autoApproveToolIds /
  generalDevelopment / generalDevelopmentDeniedToolIds / updatedAt / updatedBy）、
  `isAgentExecutionMode` / `isAgentDiscoveryMode` 判别式；`index.ts` 导出；
  `DatabaseDocument.agentSettings` 全局持久化槽位。
- `packages/industrial-agent-orchestrator/src/types.ts`：`AgentExecutionMode` / `AgentDiscoveryMode`
  字面量联合（包保持零依赖，API 层映射）、`AgentCheckpoint.autonomy?: AgentAutonomyPolicy` 与
  `discovery?`（run 启动固化、随恢复语义持久化）、`AgentToolRecord.approval?`（审批来源审计）、
  `StartAgentRunInput.executionMode / autoApproveToolIds / discovery`、`AgentToolGateway.list(mode?)`
  （缺省 curated，向后兼容）。

### 编排（packages/industrial-agent-orchestrator/src/orchestrator.ts）
- `normalizeAutonomyPolicy`：autonomous 才落 `checkpoint.autonomy`（confirm 不落字段，历史形状不变）；
  白名单 trim/dedup + 非字符串纵深剔除（路由层已先行 400）。
- `applyDecision` 要素②：`isAutoApprovedCall`（autonomous ∧ 需审批 ∧ 非 plan 档 ∧ 白名单内）
  → `state:"ready"` + 策略签发审批（`AUTONOMY_APPROVER="autonomy-policy"`，scopeFingerprint=调用指纹）
  ——下游 `aiToolReliability.validateApproval` 的指纹全等与 15 分钟时效硬校验照常，防线不降级。
- `executePending` 要素③：`AgentToolRecord.approval` 记录审批来源（策略签发 vs 人工 vs 无需确认），
  随 checkpoint 持久化；guards pre/post-execute 挂载点、取消链、写入验证证据强制全部未动。
- `initialize` / `allowedDefinitions`：`list(discoveryOf(...))` 发现面随 run 固化；
  plan 档优先级最高（autonomous 不绕过只读收敛，见测试）。

### API（apps/api）
- `ai/agentAutonomySettings.ts`（新）：resolve（读回净化：未知 mode 回落 confirm、清单 trim/dedup/限量
  200，手改持久档不放大授权面）/ mergeDraft（未知字段、非法 mode/flag/清单 fail-closed 抛
  `AgentAutonomySettingsError` 带理由码）/ `resolveRunExecutionMode`（请求覆盖??持久化默认）/
  `resolveDiscoveryMode`（general 需开关，否则拒）/ `applyGeneralDenyList`（拒绝清单优先于注册表可见性）。
- `metadataStore.ts` + `jsonStoreFoundation.ts`：`getAgentSettings` / `saveAgentSettings`
  （同 aiSettings 持久化模式；JsonStore 唯一实现，无其他子类需同步）。
- `ai/industrialAgentRoutes.ts`：
  - `GET/PUT /api/projects/:projectId/ai/agent-settings`（要素①配置面；PUT 浏览者 403，
    非法草案 400 理由码透传；保存即新运行默认生效）；
  - `GET agent-tools?discovery=general`（要素④；开关关闭 400 `general-development-disabled`；
    响应带 `generalAvailable` 供 UI 门控）；响应形状 `{tools, discovery, generalAvailable}` 向后兼容；
  - `POST agent-runs` 新增 `executionMode` / `autoApproveToolIds` / `discovery`（逐次覆盖；
    autoApproveToolIds 非字符串数组 400 `invalid-tool-list`；general 面启动前按拒绝清单收口）。
- `ai/industrialAgentToolGateway.ts`：`list(mode)` curated=策划清单（现状）/ general=注册表全量
  （仍无动态命令/shell/文件工具）；`execute` 定义查找随 `checkpoint.discovery`（curated 档
  策划环外一律 tool-not-allowed，现状不变）。

### Web（apps/web）
- `apiClients/industrialAgentApi.ts`：`listIndustrialAgentTools(projectId, signal?, discovery?)`、
  `getAgentAutonomySettings` / `updateAgentAutonomySettings`、`StartIndustrialAgentRunInput` 三字段、
  `AgentToolsView` / `AgentSettingsView`。
- `ai/industrialAgentViewModel.ts`：`AUTONOMY_APPROVER_ID` / `isAutonomousRun`（plan 档优先）/
  `describeApprovalSource` / `describeExecutionMode`（纯函数，测试覆盖）。
- `components/IndustrialAgentWorkspace.tsx`（配置面挂既有 start 面板结构，不新增大页）：
  - plan-row 内新增执行模式双 chip（逐次确认/自主执行）——点击即 PUT 持久化（失败回滚并显式报错）；
  - `generalAvailable` 时显示"全部已注册"chip，切换即以 general 面重取工具目录（授权发现）；
  - 启动请求按当前模式带 `executionMode` / `discovery`；confirm 不带字段（历史请求形状不变）；
  - 运行视图：头部自主执行徽标（plan 档优先不标注）；决策历史下新增工具记录审计列表
    （策略签发/人工确认/无需确认三态来源可见）；
  - 高风险提示文案按模式区分（自主模式明示"授权内自动执行，可随时取消，审计与验证不变"）。
- `IndustrialAgentWorkspace.css`：`.industrial-agent-mode-group` / `.industrial-agent-tool-audit`
  （全部复用既有令牌 `--line`/`--text-muted`/`ai-plan-chip`，零新色值）。

## 四、测试证据（2026-10-03 实测，全绿）

| 套件 | 结果 |
|---|---|
| packages/contracts（tsc + vitest） | 50 文件 / **464 通过** |
| packages/industrial-agent-orchestrator（tsc + vitest） | 6 文件 / **46 通过**（含新增 `autonomy.test.ts` 6 例） |
| apps/api（tsc + `src/ai` + `store.test.ts`） | 57 文件 / **406 通过**（含新增 settings 5 例、routes 4 例、gateway 1 例） |
| apps/web（tsc + ai 域 + Agent 相关组件） | 27 文件 / **175 通过**（含新增 viewmodel 2 例） |

新增 18 个测试用例覆盖四要素：
①配置面 PUT/GET 往返+读回+fail-closed 校验+浏览者 403（routes ×2、settings ×5）；
②自主执行免逐条审批+策略签发指纹一致（orchestrator ×2、routes ×1）；
③白名单外仍逐条审批+plan 档优先+自主运行取消终态+审批来源落工具记录（orchestrator ×3、routes ×1、viewmodel ×2）；
④general 面发现/curated 面保持/拒绝清单收口/开关关闭 400（orchestrator ×1、gateway ×1、routes ×1）。

对抗式自查修补：启动请求 `autoApproveToolIds` 垃圾输入原会 500 → 路由 400 `invalid-tool-list`
+ orchestrator 纵深过滤，已补测试。同族排查：`tools.list` 全部消费方核对
（ontologyActionService 无参调用=curated 现状；测试夹具无参 lambda 与 `list(mode?)` 参数兼容）。

## 五、边界与诚实声明

- **未过浏览器视觉闭环**：本会话无浏览器工具；UI 侧以组件测试（27 文件 175 例含
  IndustrialAgentWorkspace.test.tsx）+ tsc 为证，模式行/徽标/审计列表的像素级呈现未截图验证。
- **回滚语义说明**：本行"回滚继续有效"指既有回滚/恢复链（checkpoint 恢复、run 取消、
  ontology 行动回执三跳账本、provenance 账本）在自主模式下未被绕过且全部沿用——未新增独立回滚机制；
  写入/控制类"执行后验证证据缺失即失败"的既有纪律在自主模式下经测试确认仍然强制。
- **持久化作用域**：`agentSettings` 为全局默认（同 `aiSettings` 先例）；run 级覆盖逐次生效并
  固化进 checkpoint（在途 run 不受中途改配置影响）。按项目差异化授权属后续扩展面，本行未做。
- **manager 默认=confirm**：不配置时行为与历史完全一致（checkpoint 不落 autonomy 字段）。
- 帧时测量未做（硬约束禁）；cargo 未触碰（硬约束禁）；未 commit/push（硬约束禁）；
  `jc-i-continuation-20261001.md` 只读未改；受保护文件域零触碰（`git status` 对照核查，
  工作树中受保护文件的既有改动均为开工前他线产出）。
