# H-C5-K10/K11/K13 工业 Agent 运行可靠性 UI（2026-10-02）

> 状态:**本刀完成**。轮询退避/错误节流、恢复失败与陈旧/跨项目显式标注、多运行历史与
> 可恢复入口三小项同批落地;复用服务端 agentMemory runs 段与既有折叠行/语义色体系,未重建。
> 证据:本域 4 测试文件 37/37 绿 + 全量 web vitest 5491 过(3 败均为域外既有,见诚实条款)。

## 现状核查(六步)

1. **spec 原文**(`docs/specs/remaining-tasks-estimates-20260930.md:152-153`):
   K10/K11=轮询退避/错误节流;恢复失败显示 runId 与恢复入口,陈旧/跨项目状态明示;
   K13=多运行历史与可恢复入口,现码单槽 runId localStorage。均 2–5h 高信心。
2. **现码定位**:`apps/web/src/components/IndustrialAgentWorkspace.tsx`
   - 单槽键 `bim-studio:industrial-agent:<projectId>`(rememberRun/readRememberedRun,行 473-479);
   - 轮询:固定 `setInterval` 1200ms,**每次失败都 setError**(行 119-136);
   - 恢复失败:仅泛化文案"上次运行暂时无法恢复",无 runId 无入口(行 107-110);
   - `updateCheckpoint` 对 `next.projectId !== projectId` **静默 return**(行 139)。
3. **相邻批**:`hc6s2-memory-pipeline-20261002.md` 已落地服务端 runs 段——
   `GET /ai/memory` 返回 `runArchives`(终态滚动 50,路由截 10)+`runArchiveCount`;
   前端 `AgentMemoryView` 类型未消费。K8(checkpoint findings)已收口。
4. **测试形态**:ai/ 域 vitest 有 vi.mock + fake timers 先例;工作台测试族为
   `renderToStaticMarkup` 纯视图静态渲染(数据/回调全注入),本刀沿用。
5. **root 账本** `jc-i-continuation-20261001.md` 只读,未改。
6. **K9 隔离**:今日 `hc5-k9-chat-deadline-20261002.md` 已收口 chat 链;
   其文件(`ai/useAssistantChatRun`、`apiClients/assistantStream`、`ai/runAssistantRequest`)本刀零接触。

**已有(不重建)**:服务端 `AgentRunArchive` 形状与 `/ai/memory` 响应;
`agentStatusLabel/agentStatusTone` 视图模型;`ai-context-disclosure` 折叠行(AiMemoryPanel 同构);
`--agent-warning/success/danger` 语义色与三重编码先例;`ServerRequestError.status` 404 识别先例。

**真实缺口**:①固定 1200ms 无退避、失败刷屏(K10);②恢复失败无 runId/无入口、
跨项目静默丢弃、陈旧不明示(K11);③单槽 runId、无历史列表、无可恢复入口(K13)。

## 实现

### 新叶子文件(合同先行,逻辑与视图分离)

| 文件 | 行数 | 合同 |
|---|---|---|
| `apps/web/src/ai/agentRunHistory.ts` | 143 | `createAgentRunHistoryStore(storage)`:`remember`(同 runId 置顶去重,滚动上限 10)/`list`(旧单槽键迁移兜底,损坏数据 fail-closed 逐条过滤,status 白名单校验)/`forget`;`browserRunHistoryStore()`(localStorage 不可用回退进程内记忆);`isStaleAgentRunEntry`/`isStaleCheckpoint`(阈值 48h 常量) |
| `apps/web/src/ai/agentRunPolling.ts` | 36 | `createAgentPollBackoff(base=1200,max=15000)`:`next()` 指数(×2 封顶)/`reset()` 成功归零;`shouldReportPollFailure(failures)` 仅首次失败上报 |
| `apps/web/src/components/AgentRunHistoryPanel.tsx` | 191 | 容器(本地列表为权威 + 服务端 `runArchives` 异步增强,归档失败明示降级不遮挡)+ 纯视图 `AgentRunHistoryPanelView`(折叠行/陈旧徽标/终态语义色/打开入口)/`AgentRecoveryFailureNotice`(runId+原因+重试/清除/不再提示)/`AgentCrossProjectNotice`(显式标注不静默) |

### 接线(IndustrialAgentWorkspace.tsx,+127 行;文件 589 行,预警见诚实条款)

- **K10**:轮询 `setInterval` → `setTimeout` 递归链,失败 `backoff.next()` 排下一次、
  `shouldReportPollFailure` 节流(连续失败只在首次 setError),成功 `reset()` 回 1.2s;cleanup 清 timer+abort。
- **K11**:①恢复链改为先读 `latestRememberedRunId` 再拉取,rejected 时按
  `ServerRequestError.status===404` 分型落 `recoveryFailure{runId,notFound,message}`,
  UI 显示 runId 短码+原因+「重试恢复」(404 则改「清除记录」+「不再提示」);
  ②`updateCheckpoint` 跨项目分支由静默 return 改为 `setCrossProject` 显式标注
  (warning 色条,说明已忽略更新并给出查看路径);③恢复成功后 `isStaleCheckpoint(checkpoint)`
  超 48h 时 restored 文案切换为「状态可能陈旧」。
- **K13**:start 视图第三折叠行「历史运行」(与记忆/档案同构,默认收起,不堆面板);
  `rememberCheckpoint` 升级为滚动列表(objective/status/savedAt 全记);条目「打开」走
  `openRememberedRun`(epoch 所有权+actionPending 防并发;跨项目运行只标注不替换视图,
  项目作用域守卫不放松);onToggle 时重读本地(其他组件 remember 后打开即最新)。
- 旧单槽键迁移语义:`list` 时迁移,新键写成功才删旧键;写失败旧键保留、下次再试,
  用户既有恢复状态不丢。

### 消费的服务端数据(只读,零 API 改动)

`GET /api/projects/:id/ai/memory` 的 `runArchives`(apps/api/src/ai/agentMemoryRoutes.ts:42,
`AgentRunArchive` 见 agentMemory.ts:50)——按 runId 补终态状态徽标与缺失 objective;
`apps/web/src/apiClients/industrialAgentApi.ts` 仅扩类型(`AgentRunArchiveView` 镜像+`AgentMemoryView` 补字段)。

## 测试证据

新增 3 文件 + 既有族扩展,本域 **37/37 绿**(vitest 0.97s):

- `src/ai/agentRunHistory.test.ts`(12):空态/滚动逐出/upsert 置顶/**旧键迁移**(删旧键+新键落盘+
  后续 remember 追加)/**迁移写失败兜底**(旧键保留仍可读)/损坏数据三类 fail-closed/
  非法 status 白名单过滤/存储抛异常静默降级/forget/forget 空列表不复活旧键/陈旧判定×3(含无效时间戳)。
- `src/ai/agentRunPolling.test.ts`(4):退避序列 2400→4800→9600→15000 封顶不增长/
  reset 复位/自定义 base+max/节流(首败上报,连败不上报,0 不上报)。
- `src/components/AgentRunHistoryPanel.test.tsx`(9):本地记录渲染/归档目标回填+终态徽标/
  无归档显式「状态未知」不伪造/陈旧三重编码标注/空态/归档失败明示降级/
  恢复失败 notice(原因透出+重试入口)/404 分支(无重试,有「清除记录」与文案一致)/跨项目 notice。
- `src/components/IndustrialAgentWorkspace.test.tsx` 既有 6 例不动 + 新 2 例:
  跨项目显式标注渲染、restored 陈旧/新鲜双分支文案。

回归:apps/web 全量 vitest **5491 passed**(3 failed 为域外既有,见下);本域含
`industrialAgentViewModel.test.ts` 在内全绿。

tsc:本域 **0 错**。全局余 2 处域外既有错误,均非本刀引入:
`externalResourceApi.test.ts`(未跟踪新文件,并行线路)、`DashboardWidgetRuntime.tsx`(工作区已有改动,git diff 确认无本刀内容)。

## 诚实条款

- **未过浏览器视觉闭环**:本环境未运行浏览器 E2E;历史区/notice 的视觉呈现以
  既有 `ai-context-disclosure`/语义色变量体系复用保证,静态渲染断言覆盖文案与结构,
  实际观感(折叠展开动线、窄屏 540px 断点下历史行换行)未实测,风险低但如实声明。
- **轮询退避的组件接线未做集成测**:纯逻辑(退避序列/节流)已测;setTimeout 链接线
  (~15 行)靠静态渲染测不到,以手工推演覆盖(cleanup 清 timer、abort 后不排新 timer、
  refreshing 防重入三路已核对)。手动刷新成功不会重置轮询自身退避计数(独立计数器),
  最坏多等一个封顶间隔(15s),记录为已知取舍。
- **主文件体量预警**:`IndustrialAgentWorkspace.tsx` 589 行(既有 483+接线),超 500 预警线
  未超 800 阻断线;增量逻辑全部在三个新叶子文件,主文件只剩状态接线,后续拆分留给运行视图独立成文件的专项。
- **域外失败如实列出**:`architecture.test.ts`(2 个并行线路未跟踪测试文件触发边界违规)、
  `StudioDeepWebGpuBridge.test.ts`(2 例,viewer 域,本刀零接触)——均在本刀改动前即失败,未修(域外)。
- K9 文件、behavior/*、viewer/declarative*、api/opcUa*、apps/api/src/ai/* 全部零改动;未 commit。

## 同族排查记录

- 单槽键残留消费方:全仓 grep `bim-studio:industrial-agent` 除新 store 外零命中;
- `rememberRun/readRememberedRun/restoreRun` 旧符号:已全部替换,无悬挂引用;
- `industrial-agent-history` 类名与既有「决策与工具记录」冲突:历史面板改名
  `industrial-agent-run-history`,grep 确认无第二处使用;
- 损坏数据防线同族:parseHistory 白名单校验 status(防 agentStatusLabel 渲染空白),
  归档合并处 `typeof archive.status === "string"` 防御同样保留。
