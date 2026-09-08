# 脚本 AI 请求生命周期修补与验证

## 已完成

范围：`SceneBehaviorAgentWorkspace` 的生成、解释、诊断请求可靠性，复用现有模型流式通道、受限草稿编译、确认插入和撤销。未修改 Provider 配置、账户、正常存储或项目原数据，未调用在线收费生成。

- 新增请求所有权与同步去重；停止、切换能力/项目/场景/脚本/目标/编辑内容和关闭时取消。迟到回复及旧请求的 finally 不得覆盖较新请求。
- 解释/诊断可显示流式文字；生成的归一化响应必须完整通过结构校验、白名单与静态检查，部分流不能作为脚本插入。
- 提供方失败保留确定性本地诊断；取消不伪装成模型失败。后续输入保留，不自动插入、保存、启用或运行。
- 真实浏览器额外复现 Monaco minimap 穿透遮挡 AI 按钮；编辑器内部层级隔离后恢复真实点击。助手外壳、审查卡及确认按钮改为现有主题令牌。

## 权威证据

- `pnpm --filter @bim-studio/web exec vitest run src/ai/scriptAssistantSession.test.ts src/components/SceneBehaviorAgentWorkspace.test.tsx src/components/sceneBehaviorAiDraft.test.ts src/ai/sceneScriptDraft.test.ts`：4 文件、22 项通过；Web typecheck 通过。
- 主线程统一构建：`.runtime-logs/codex-20260908-unified-build-r37.log`。
- `node apps/web/scripts/gate-script-ai-session.mjs`：真实安装 Chrome、隔离 API/项目，两轮 × 深色 1440 / 浅色 980，共 4/4。
- 报告：`test-output/codex-2026-09-05/script-ai-session-D3cCwv/report.json`；每组包含 pending/fallback/review/undo 截图。两轮截图已亲审，遮挡已消失，浅色审查卡不再保留深色硬编码。
- 覆盖停止→重试→旧回复释放、切能力、切脚本、返回后重开、提供方错误降级、拒绝可执行模型文本、合法声明→静态审查→确认插入→撤销恢复原文。全部 0 API 保存写入、0 非预期 console 错误/警告；检查文字最低对比度深色 5.53、浅色 4.56。
- 初次失败证据：`script-ai-session-mnJrIk/r1-dark-failed.png`，旧构建真实点击被 minimap canvas 阻挡。未使用 force click 或删掉断言绕过。

模型传输使用确定性 SSE 夹具，证明编排与交互，不证明在线模型质量、真实流式延迟或预测维护模型效果。此门禁刻意确认零自动写入；未把它计为 AI 看板资产化的保存、发布及匿名读取验收。

## 对标与十维复核

设计基线复用 [AI-UP §1](specs/AI-UP-ai-capability-interaction-plan.md)：Copilot 类上下文/中断/确认撤销动线，FVS 工程信息组织与西门子克制语义；令牌来源 `apps/web/src/styles/base.css`。不是在线竞品全面实测结论。

| 维度 | 自检 | 证据与边界 |
|---|---:|---|
| 布局 | 9 | 两轮真实点击，遮挡修复；980 窄窗仍可返回脚本 |
| 令牌 | 9 | 双主题卡片、底色、确认按钮一致 |
| 排版 | 8.5 | 主交互 12px；既有审查摘要/技术明细仍有 10px，小字号进入全局排版收尾 |
| 交互状态 | 9 | 停止、失败降级、不可插入、确认、撤销实测 |
| 动效 | 不适用 | 未新增动画；不以静态截图验证动效 |
| 3D 渲染 | 不适用 | 未改渲染，背景场景不计本批渲染验收 |
| 信息设计 | 8.5 | 事实/模型辅助已区分；既有审查说明和标签仍偏密，进入全局减负收尾 |
| 反馈 | 9 | 点击立即转停止；错误/取消反馈保留；在线流速未评测 |
| 响应式/主题 | 9 | 1440 深色与 980 浅色各两轮；480 未在本批验收 |
| 语义文案 | 9 | 无“取消=失败”，无草案自动执行，模型辅助不冒充运行证据 |

## 本轮待办

上述排版/信息减负、480 面板与跨项目浏览器路径在全局 UI/边界验收继续；项目上下文失效的同步拒绝与 AbortSignal 已有聚焦测试。AI-2 预测维护、AI-3 看板资产化、AI-4 多轮会话深度与 AI-5 模型质量评测不因本批可靠性修补而完成。

## 明确排除

不接 GPT、不恢复暂停的统一语义与公开数据治理、不自动重放模型写操作、不 push。
