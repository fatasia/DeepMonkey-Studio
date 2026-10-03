# 助手"计划→执行→验证"闭环(场景改动)— 2026-10-03

> Design Read:对标 Cursor 的"改动可审阅/可回滚"+ Unity AI 的"应用后自检"+ 西门子式状态三重编码;深色工程语言,全部令牌来自 `apps/web/src/styles/base.css`,强调色派生自 `--accent`。

## 现状核查

### 已有(不重建)

| 能力 | 位置 | 说明 |
| --- | --- | --- |
| 场景命令 IR(19 类)+ 严格校验 | `packages/scene-sdk/src/protocol.ts`、`commandValidation*.ts` | `validateSceneCommand` 逐条校验未知输入 |
| **命令事务**(prepare / CAS / 取消 / 失败整批回滚 / receipt) | `packages/scene-sdk/src/sceneCommandTransaction.ts` | `prepareSceneCommandTransaction` 产出 `plan.diff`(仅 `type → target` 摘要,**无前后值**);`commitSceneCommandTransaction` 原子提交,driver 异常/部分失败/取消一律 `rollback` |
| 浏览器 driver(逆算子栈,倒序回滚) | `apps/web/src/studio/editorSceneWriteDriver.ts`(`runEditorSceneTransaction`、`sceneMetadataDraftPatch`) | 执行走 `ViewerSceneCommandPort`+`SceneCommandExecutor`;不可逆项(动画控制/数据推送)已声明 |
| 撤销栈与单撤销单元 | `SceneAuthoringHistory`(`studio/sceneAuthoringHistory.ts`)、`SceneEditTransaction`(`hooks/useSceneHistoryState.ts`:`flush.beginTransaction(label)` → `commit()` 合并为一条)、`useSceneHistoryActions.undoSceneEdit` | 事务窗口内 `onModelChange` 散记全部吸收;删除链已用该事务 |
| 编辑器 presence + MCP 写事务桥 | `apps/api/src/mcpEditorSceneTransactionBridge.ts`、`hooks/useEditorPresence.ts` | **外部 MCP 客户端**经轮询桥驱动浏览器 driver;不是应用内助手通道;MCP 写入未进撤销栈(仅删除进) |
| 视口取帧 | `studio/sceneThumbnailCapture.ts`(同步重绘+`toDataURL`)、`editorSnapshotFetchBridge.ts`(PBR readback 拉取) | 缩略图口径 480px;MCP 视觉循环用 frame readback |
| 引擎只读口 | `ViewerEngine.listModels/getModelTransform/getModelMaterialState/getCameraState/getGlobalLighting/getSceneEnvironment/getWeather/getSelected` | 前后值读取面齐全 |
| 助手对话与"执行任务"编排 | `apps/api/src/ai/assistantService.ts`(`scene` 模式,**纯文本**)、`industrialAgentToolGateway.ts`(20 精选**工业**工具,无场景编辑工具)、`@bim-studio/industrial-agent-orchestrator`(plan/confirm/autonomous、审批、`verificationEvidence`) | 编排器的写类工具已强制"事后独立验证证据",但全部是**服务端工具**,无法触达浏览器视口 |
| 审计链 | `createMetadataAiAuditSink`;`api.askAssistant` 每次模型调用已审计(input-assessment/model-completion);`provenanceLedger` 是**假设/研究运行**链(report/study-run),且浏览器只读 | 场景改动不属于该账本的节点类型 |
| 行为脚本沙箱 | `SceneBehaviorPanel`、`behavior/*`、`sceneBehavior.worker`、Play 模式(退出整体恢复) | 脚本是另一条链路;Play 态一切编辑吸收 |
| World API(`world-api-v1-20261003.md`) | **未落盘** | 只依赖现有命令 IR;其契约落盘后以 `SceneCommand` 兼容层对接 |

### 真实缺口

1. 应用内"执行任务"页没有任何通道让模型提出**场景命令批**并在浏览器内应用(编排器是服务端、工具网关无场景编辑工具;MCP 桥是外部客户端用)。
2. `plan.diff` 只有一句摘要——**没有前后值**,无法"可审阅"。
3. 批量命令在撤销栈里**不是一个单元**(非删除命令只靠防抖散记)。
4. 应用后**没有观测回喂/自检**:无视口取帧到 UI、无"期望 vs 实际"确定性比对、无"达成/未达成+修正"循环、无轮次上限。
5. 模型通道**纯文本**(`assistantService` 无图片入参):截图不能直接喂模型,只能喂数值化观测。
6. 场景改动回执没有写入审计链的路径(provenance 账本类型不匹配)。

## 方案

**浏览器内闭环**(复用 `commitSceneCommandTransaction` + `EditorSceneWriteDriver` + `SceneEditTransaction`;模型走既有 `api.askAssistant("scene")`,每次调用已被审计):

- `ai/sceneEditState.ts` — 可序列化场景状态快照 + 命令仿真 + **前后值差异**(新增/修改/删除、字段级前后值、不可撤销标注、目标不存在即阻断)+ 期望-实际确定性核对。
- `ai/sceneEditProtocol.ts` — 提议/裁决提示词(合同:严格 JSON、弧度、≤12 条命令)与响应解析。
- `ai/sceneEditSession.ts` — 会话状态机:`plan` 只出计划 / `confirm` 每轮需确认 / `autonomous` 自动循环,**修正轮次上限(默认 2,可配 0–3)**,可取消、可撤销。
- `ai/sceneViewportObservation.ts` — 视口截图(JPEG,≤1280 宽)+ 数值观测(平均亮度、非背景占比、3×3 亮度网格、指纹)。
- `hooks/useSceneEditPort.ts` — 把引擎/撤销栈/driver 包成端口:原子应用+单撤销单元、截图、撤销并校验还原。
- `components/SceneEditLoopCard.tsx` — 仅在"执行任务"页出现:差异 / 应用 / 验证 / 撤销;无新增常驻区域。

审计:两次模型调用走既有审计;应用与撤销回执(plan 指纹、receipt、观测指纹、裁决)以 `AiSceneEditRecord` 保存在会话内并展示;**后端落账需要新的写路由,记为遗留**(见实施结果)。

## 实施结果

### 已交付(闭环子集全部落地)

**数据流**:`执行任务页 → 场景改动开关 → 模型提议(scene 模式,严格 JSON) → SDK 逐条校验 → 差异预览(前后值) → [确认] → 原子应用(一次撤销单元) → 取帧+状态核对 → 模型自检 → (未达成)修正轮 ≤N → 一键撤销(校验还原)`。

| 能力 | 实现 |
| --- | --- |
| 差异预览 | `ai/sceneEditState.ts`:`simulateSceneCommands` 逐条仿真,字段级前后值(位置/旋转°/缩放/颜色/可见性/灯光/环境…),新增/修改/删除/动作四类,同对象多命令并入一条,不可撤销运行时效果标注,目标不存在/锁定/宿主未开放 → `blockers` 禁止应用 |
| 原子应用+单撤销单元 | `ai/sceneEditPort.ts` → `runEditorSceneTransaction`(SDK CAS+driver 逆算子整批回滚);无删除的批包在 `flush.beginTransaction` 窗口内 `commit()` 落**一条**撤销条目,含删除的批由 driver 的删除事务以同一标签收口;场景级命令回写 draft(`flushSync`) |
| 观测回喂 | `ai/sceneViewportObservation.ts`:应用前/后视口截图(JPEG ≤1280 宽,记录原始分辨率与 SHA-256 前 8 字节指纹)+ 数值观测(均值亮度、内容占比、3×3 亮度网格);`verifyExpectedFacts`:仿真预期 vs 引擎读回的确定性核对(**不依赖模型**) |
| 模型自检 | `ai/sceneEditProtocol.ts`:验收提示词含 checks/diff/应用后对象状态/视口数值;**核对失败时强制判未达成**(模型说成功也不信);模型不可用 → `unverified`(确定性核对通过但未获模型确认,如实标注) |
| 轮次上限 | `ai/sceneEditSession.ts`:修正轮次默认 2,UI 可选 0–3,硬上限 3;`maxCorrections=0` 时验收提示词禁止 correction |
| 执行方式映射 | 只出计划=仅差异(用户可再确认应用);逐次确认=**每一轮**(含修正轮)应用前确认;自主执行=自动应用/验证/修正,**含不可撤销运行时效果(动画/数据/组件)仍降级为需确认** |
| 前值失效保护 | 审阅期间场景作者状态变化(指纹不一致)→ 拒绝应用并提示重新生成,不悄悄覆盖 |
| 撤销 | 倒序撤销本任务各轮;仅当栈顶是本批才执行(其后有新编辑则给出明确提示);撤销后以作者状态指纹校验还原("已撤销,作者状态已校验还原") |
| 审计 | 模型调用沿用 `/api/ai/assistant/stream` 既有审计;新增 `POST /api/projects/:id/ai/scene-edit-records`(`apps/api/src/ai/sceneEditAuditRoutes.ts`,viewer 403,严格校验)把 `applied/rolled-back/verified/undone` 回执(plan 指纹、receipt、核对数、视口指纹、裁决)以 `tool-result` 事件写入持久化审计链;**仅指纹,不含命令参数/截图**;写入失败不阻断改动,卡片如实显示"审计记录失败 N 条" |
| UI | 仅"执行任务"页:工具栏增一个"场景改动"开关(仅 Studio 出现)+"修正 N 轮"下拉;改动在原位替换为结果卡(状态条/差异/截图前后对比/状态核对/裁决/撤销),较早轮次折叠;**无新增常驻区域**。令牌全来自 `base.css`(状态=图标+色+文字;loading 骨架、error、disabled、focus 齐全;入场 280ms expo.out + stagger 40ms;`prefers-reduced-motion` 降级) |

**接线改动**:`App.tsx` 把已有的 `sceneAuthoring` 提为 const 并放入 `viewBindings`(`appViewBindings.ts`),`useEditorPresence` 与助手共用同一写入口;`AppStudioViewport` → `AiAssistantPanel` → `IndustrialAgentWorkspace` 传 `sceneEdit` 端口。

**设计取舍**
- 事务作用域固定为 `"active-scene"`:未保存场景首次保存会换 ID(自动保存默认开),用真实 ID 会让审阅期间的换 ID 变成 `scene-mismatch`;场景切换导致的变化由前值指纹兜底。
- 模型通道仍是纯文本:截图展示给用户并以指纹/数值入审计与提示词,**未直接喂图**(见遗留)。
- 未复用 `plan.diff`(仅摘要)而是新增仿真 diff;但应用仍走 `prepare/commit` 全部治理(校验/能力/CAS/回滚)。

### 验证

- `apps/web`:`tsc --noEmit` 无错;vitest `src/ai src/components src/views src/hooks src/studio src/behavior src/commands src/apiClients` 全部通过(2720 用例,新增 37:state 7 / protocol 5 / session 13 / port 4(真实作者引擎夹具:原子回滚、一次事务、栈顶撤销)/ card 6 / pixels 2)。
- `apps/api`:`tsc --noEmit` 无错;`sceneEditAuditRoutes.test.ts` 3 用例通过。
- 浏览器端到端(深色 1920×1080,真实引擎+路由注入模型响应,脚本 `files/scene-edit-shot.mjs`):逐次确认(差异→应用→12/12 核对→达成→撤销并校验还原)、自主执行(提议→未达成→自动修正 1/2 →达成,5 次模型调用)、审计 7 条均 202。截图:`se8-4-diff / se6-5-verified / se6-6-undone / se6-7b-full`。
- `gate-agent-scope.mjs`:断言在 `entry.contrast.length >= 5` 处失败——该脚本期望的 `.industrial-agent-heading` 等元素已在助手简化时移除(与本任务无关,此前即失败);其余断言(无写入、无错误、对比度 ≥4.5)通过。

### Kimi-95 自评(深色 1920×1080 实测)
布局构图 9 · 令牌一致性 9.5(CSS 无硬编码色,有测试守卫)· 排版 9 · 交互状态 9(loading 骨架/error/disabled/focus/空截图降级)· 动效 9 · 3D 渲染(n/a,沿用既有视口)· 信息设计 9(前后值删除线→结果,tabular-nums,单位/小数统一)· 反馈即时性 9(≤100ms 进入骨架,模型调用期间可取消)· 响应式/主题 8.5(仅测深色 1920;≤520px 单列规则未实测)· 语义文案 9(状态词唯一:已达成/未达成/未验证)。对标:Cursor 的"改动可审阅/可回滚"、Unity AI 的应用后自检、西门子式三重编码。

### 遗留
1. **模型直接看图**:`assistantService` 纯文本,需 provider 支持图像入参后,把 `afterShot.dataUrl` 作为 vision 输入(接口已留:`buildVerdictPrompt` 的 viewport 位)。
2. **World API**:`world-api-v1-20261003.md` 未落盘;其契约落地后只需把命令来源换成其 `SceneCommand` 兼容层,闭环不依赖它。
3. `object.set-parent`、`animation.*`、`data.apply`、`component.update` 仅显示摘要差异(无前值读取口);动画/数据/组件为不可撤销。
4. 缩略图/截图用 WebGL 画布同步重绘(与 `captureSceneThumbnail` 同口径);WebGPU Deep 输出面不在本次范围。
5. 开发库 `智造综合案例验证` 里留有验收脚本保存的"未命名场景"若干,可手动清理。
6. `gate-agent-scope.mjs` 的陈旧断言需随助手简化同步更新(不在本任务范围)。

## 交接(阶段 1 收尾,2026-10-03 17:45,交 GLM)

### 稳定性核验(收尾时实测)
- `apps/web`:`tsc --noEmit` 无错;vitest `src/ai src/components src/hooks src/studio src/views` 420 文件 / 2400 用例全绿;`vite build` 成功(输出到临时目录后已删除;注意首次构建曾因他人在途文件瞬时失败,重跑通过)。
- `apps/api`:`tsc --noEmit` 无错;`sceneEditAuditRoutes.test.ts` 3 用例通过。
- 无半成品:所有新增代码均已接线并通过测试。功能入口是"执行任务"页工具栏的"场景改动"开关,默认**关闭**(`sceneEditOn=false`),仅 Studio 且有 `sceneEdit` 端口时才出现;关闭时旧链路行为不变。

### 已完成
见上文"已交付"表:差异预览、原子应用+单撤销单元、观测回喂+确定性核对+模型自检、修正轮次上限(默认 2,0–3)、三种执行方式映射、前值失效保护、倒序撤销+还原校验、审计回执(`POST /api/projects/:id/ai/scene-edit-records`)、仅"执行任务"页的 UI(深色 1920×1080 实测)。

### 未完成
1. **模型直接看图**:`assistantService` 纯文本,截图只展示+指纹/数值入提示词。
2. `object.set-parent`/`animation.*`/`data.apply`/`component.update` 只有摘要差异(无前值读取口);后三者不可撤销。
3. 响应式(≤980/520)与浅色主题未实测;只做了深色 1920×1080。
4. 浏览器截图未覆盖"失败回滚""前值失效""撤销栈顶被他人编辑"三个错误态的视觉(逻辑有单测,UI 文案有 SSR 测试)。
5. `gate-agent-scope.mjs` 过时断言(`entry.contrast.length >= 5`,目标元素已被助手简化移除)——非本任务引入,需随助手简化同步更新。
6. 源码体量:`apps/web/src/App.tsx` 878 行(基线 862,本任务 +16 行,超 800 行门槛但属既有超标文件)。

### 已知风险
- 事务作用域固定为 `"active-scene"`(`hooks/useSceneEditPort.ts` 的 `ASSISTANT_ACTIVE_SCENE_ID`),因未保存场景首次保存会换 ID;切换场景由 runner 的前值指纹(`sceneAuthorFingerprint`)兜底,若 GLM 改为真实 sceneId 需处理换 ID。
- `sceneEditPort.apply`:含删除的批走 driver 删除事务(同标签),不含删除的批走 `beginTransaction`;若将来 driver 支持多删除或混批语义变化,撤销单元假设需复测(`sceneEditPort.test.ts`)。
- 撤销 `port.undo(label)` 依赖撤销栈顶标签等于本批标签(含 `AI 改动 xxxx·N` 前缀);标签格式变更会使撤销拒绝。
- 视口截图/指纹取自 WebGL 作者画布同步重绘(与 `captureSceneThumbnail` 同口径),WebGPU Deep 输出面不在范围。
- 审计回执写入失败不阻断改动,仅在卡片显示"审计记录失败 N 条"。
- 开发库"智造综合案例验证"里有验收脚本保存的若干"未命名场景",需手动清理。

### 下一步精确动作(供接手)
1. 视觉输入:在 `apps/api/src/ai/assistantService.ts` / `openAiCompatibleProvider.ts` 支持 `images` 入参后,于 `apps/web/src/hooks/useSceneEditLoop.ts` 的 `ask` 里附 `round.applied.afterShot.dataUrl`(需让 `SceneEditAsk` 增加 `images?: string[]` 参数,并在 `SceneEditRunner.verify` 传入 `shot.dataUrl`)。
2. 前值读取口:为 `set-parent` 在 `sceneEditState.ts` 的 `SceneObjectState` 增加 `parentId`,`readSceneState` 读取并在 `simulateSceneCommands` 的 `object.set-parent` 分支补 before/after 与 `expected` 事实。
3. World API:`docs/specs/world-api-v1-20261003.md` 落盘后,在 `sceneEditProtocol.ts` 的 `CONTRACT` 提示词与 `normalizeProposal` 中对接其命令兼容层(不改 runner/port)。
4. 补视觉验证:用 `files/scene-edit-shot.mjs`(会话目录)扩展浅色/980/480 档与三个错误态截图;修 `.scene-edit-*` 在窄屏的布局。
5. 更新 `apps/web/scripts/gate-agent-scope.mjs` 的陈旧选择器,并可新增一份 `gate-scene-edit-loop.mjs` 固化本次浏览器流程(路由注入 `**/api/ai/assistant/stream`,登录 admin/admin,`/studio/new`)。

### 需要的决策
- 是否把"场景改动"开关默认对 Studio 开启(现为默认关闭)。
- 修正轮次默认值 2 / 上限 3 是否合适;自主执行下是否允许对 `animation/data/component` 免确认(现强制确认)。
- 审计事件是否需要进入实验档案(`provenanceLedger`)而非仅 `tool-result` 审计链(现仅后者)。
