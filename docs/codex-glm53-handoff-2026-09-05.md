# Codex → GLM / 后续 Codex 接手说明（2026-09-05）

本文件接续 `glm53-handoff-2026-09-05.md`，不是覆盖其历史记录。状态仅用已完成、本轮待办、明确排除、项目级后验收。

## 1. 先读与工作区

1. `AGENTS.md` → `active-task-recovery-ledger.md` §15.5 → 本文件 → `ui-report-recheck-2026-09-05.md` → `docs/specs/` 实际回填。
2. 实际仓库 `D:/Documents/bim/bim-studio`，分支 `dev-studio`；本轮基线 `b1b2222`。先看 git log/status/diff，勿重做。
3. 只本地 git 提交，严禁 push。admin/admin 固定；PostgreSQL + MinIO 与 `.env` 不动，原场景不能删除/替换。
4. Codex 已获用户直接修改授权；用户说明旧“大改请示”限制针对 GLM。授权不是改凭据/拓扑或执行无关外部操作的许可。
5. 外层 `D:/Documents/bim/UI测试问题报告-20260905.md` 由 GLM 继续测试更新。以 mtime/编号增量复核，不覆盖 GLM 报告、不把报告当全部真实。
6. 用户要求测试全局启动 Web，不启动 client 模式：`pnpm studio check`；必要时用既有 `pnpm studio start web --no-open`。API watch 编辑时短暂重启，先健康再跑端到端，不能为临时 502 改密码。

## 2. 已完成（本轮增量）

### SIM 实体真正写回与静态覆盖层

- `controllers/sceneSimulationController.ts`：实体更新/删除走 activeScene、revision 与记录编辑，不再写不可保存的孤立草稿 ref。
- `sceneSnapshotFactory.ts`：把 simulationEntities（包括空数组）加入保存快照；同时修正缩略图缺失回退和 publicationToolbarVisible=false 保留。
- `scenePersistenceController.ts`：保存响应合并保留请求期间的实体新编辑；切换场景后旧响应不恢复旧仿真实体。
- `sceneImportRebinding.ts`：path、flowLink、collisionPair 的对象引用迁移；contracts 校验有限数值/非负数/路径点/循环枚举。
- `views/AppSimulationInspector.tsx` + 场景树：选中仿真实体展示对应检查器，编辑/删除写回；断链显示、键盘选择。
- `simulation/sceneSimulationOverlay.ts` 定义纯薄通道；viewer adapter 挂 engine.scene 的独立辅助组，不进 modelRoot、不拾取/导出/保存，清理材质几何。
- 当前覆盖的是“已编写的静态路径、flowLink”，不是 AGV 实时轨迹、热力或 KPI。

真实验证：QA 场景修改路径名/速度/循环 → 保存 → 刷新恢复，拖动/缩放/折叠面板、关闭覆盖层清理已检查。截图 `sim-compact-dragged-1280-dark.png`、`sim-overlay-cleaned-1280-dark.png`。

### 编辑器与工具窗体验

- 页面仅底部，图层左侧，删除重复页面管理；底部页签键盘漫游、复制/删除/最后一页保护。
- 框选坐标改用 artboardRef 实际包围盒，修正滚动容器与缩放画布坐标混用；不是仅修改测试等待。
- Ctrl+滚轮使用显式 passive:false 监听，消除 preventDefault 被动监听警告。
- 2D 门禁改为真实按键组合、确定性 QA 夹具，4 个主题/宽度组合；框选/Shift/Ctrl、10%→11% 的 60 帧检查无漂移。
- 仿真折叠只隐藏 body，不卸载当前表单；边界按折叠尺寸计算。工位/机器人窄容器布局加明确作用域，避免懒加载 CSS 优先级覆盖。
- 工位面板 420px 外宽时 body clientWidth=scrollWidth=403；`simulation-workcell-1280-light.png`。

### UI 报告与可靠性

详见 [逐项复核](ui-report-recheck-2026-09-05.md)。已修 AI 等待反馈/防重复、Esc、跨项目搜索、登录 5xx 指引、HTML 启动提示、管理页窄屏、连接名称与监控对比度、时间格式、局部主题、优化器禁用态、日志 ANSI 清理。

旧发布记录：`scenePublicationHistory.ts` 合并真实当前快照，读操作不写库；重新发布/取消发布时保留已有快照。Web `useScenePublicationHistory.ts` 提供过期响应保护、错误/重试，防止接口失败误报空列表。真实旧场景“1”已可读到 2026-08-26 快照；本轮没有重新发布它。

## 3. 文档交付（已完成）

- [SemaPLC / Astral3D / astral-service 分析](semaplc-astral-value-analysis-2026-09-05.md)：价值、源码证据、授权差异、采用/不采用。不能把注释掉的 Revit 配置当可用 RVT 转换服务。
- [S3-B](specs/S3-B-component-depth.md)、[S3-C](specs/S3-C-industry-template-depth.md)：明确计数口径、真实数据/交互/发布证据与旧 ID 兼容。仅规格已完成，未冒充 300+ 已实现。

## 4. 本轮待办（按接手优先级）

| 顺序 | 任务 | 从哪里继续，完成口径 |
|---|---|---|
| 1 | GLM 报告增量 + 已确认待复核项 | 先对照复核表，重点 P2-11 Agent 数据集、日志页/复制失败态、拓扑 fit/状态，不盲改未复现项 |
| 2 | AI 请求生命周期 | AiAssistantPanel 目前在准备 BIM 上下文后才建 AbortController；取消/关闭之前的准备不应继续发请求。SQL 两步请求也需取消/过期防护；不能结束时清空用户后来输入的问题 |
| 3 | SIM 四面板运行态深测 | 32 组基础布局/折叠检查已通过；继续真实运行/错误态/键盘、子面板下半部分、关闭与切页生命周期，不能只看首屏 |
| 4 | SIM-1a 剩余完整闭环 | 创建角色/源汇/队列 → 绑定实体参数到既有物流运行器 → 运行结果适配覆盖层 → 同一 Study 证据 → 时间线播放；静态路径不能算全部完成 |
| 5 | 仿真可停靠与状态保留 | 当前只有拖动/缩放/折叠，不是完整 dock/autohide；切换 tab 的 OperationsCenter 有 key，仍会卸载。若新增停靠，按工作区尺寸保留可操作视口，不重写壳层 |
| 6 | 2D 深度交互/规格余项 | 核对已提交 Alt 拖拽/右键选层的真实行为与撤销条数，再回填；EX-002/S1-002 按现有规格推进，不重建语义合同 |
| 7 | 素材/模型入口持续验证 | 旧 U1-4 能力已恢复；继续导入→转换→优化→新素材保存→场景使用。平台支持格式≠全部转换器已可用；不得用空态隐藏真实能力 |
| 8 | S3-B/C 实现与全站打磨 | 按领域分批，不凑数；继续浅色主题、18 个大文件职责拆分、hooks 测试；新增文件原则 ≤300 行 |

保存并发还有可收紧处：sceneSimulationController 的外层 revision/history 触发在过期回调时可能发生，即使内部 setActiveScene 防护拒绝数据写入；补旧闭包切场景测试。当前 snapshot 合并保护只针对仿真实体，不代表其它字段的所有并发保存问题已全解。

## 5. 明确排除

不 push、不修改账户/存储、不继续外部素材下载（停在 164 GLB）、不做工业格式真实转换验收、不安装 Revit/Docker、不做认证动力学/完整 OLP/完整 PLM/厂商控制器矩阵，不恢复用户已取消的 WebGPU 8 小时 soak。保留已有功能，不删除。

## 6. 项目级后验收

任意客户大模型/工业格式/仿真正确性不是固定 QA 夹具可证明；仍需真实样本矩阵。核心开发完成后统一性能、长稳、故障注入、全站 E2E/视觉/无障碍及发布回滚验收；当前局部修复不得写“已全面超过 Siemens/Unity/Figma”。

## 7. 验证与产物

2026-09-05 10:47 基线：全仓 typecheck 通过；`pnpm -r test` 全通过，Web 320 文件/1127 项，API 110 文件/434 项；1704 个源文件均 ≤800 行。随后局部主题/文案打磨需以最后复跑记录为准。

```powershell
pnpm typecheck
pnpm -r test
node --test scripts/lib/nativeProductionOps.test.mjs scripts/studio.test.mjs
node apps/web/scripts/gate-ui-report-20260905.mjs
node apps/web/scripts/u112b-selection-verify.mjs
node apps/web/scripts/u116-ctrlwheel.mjs
node apps/web/scripts/gate-simulation-panels.mjs
pnpm --filter '@bim-studio/web...' build
pnpm studio check
git diff --check
```

测试资源均在 `test-output/codex-2026-09-05`（gitignored）。UI 报告门禁 `ui-report/report.json` 与双主题截图；`selection/`、`ctrl-wheel/`；手动 SIM 保存恢复截图。源码脚本纳入 git；截图留本机。报告中故障注入响应不计真实服务故障，普通控制台错误不能忽略。

专用 QA 项目 `dfc62dfa-22f7-40ce-8cbe-aab2271cdc56`，QA 场景 `abe8f38f-bdc3-47c7-89e3-a18c93069a9b`。原“智造综合案例验证”仍 14 个场景，未删除。不要把这些 ID 当部署时常量。

用户要求飞行期间继续工作；已配置每 30 分钟检查 GLM 文件更新的本任务 heartbeat（至 2026-09-05 15:00 窗口）。无新项时继续本表队列；只在有实质变化时通知，不报空转进度。

### 本轮收口增补

- 四面板基础布局：1440/980 视口 × dark/light × 520/420 工具窗 × 四面板，共 32 组；无横向内容溢出、窗口不出界，折叠/展开表单值保持。脚本 `gate-simulation-panels.mjs`，产物 `simulation-panels/report.json`。首版脚本假定物流区有 heading 导致等待超时，已改等实际内容，不改产品去迎合测试。
- 目视增补：What-if 主操作保持单行；标定区、优化器页面、数据监控中性颜色使用现有令牌，监控标题对比度门禁 ≥4.5:1。
- 生产构建：直接只构建 Web 首次失败（contracts 生产 dist 旧、缺少 validateSimulationEntities 导出）；运行 `pnpm --filter '@bim-studio/web...' build` 重建依赖后成功。不是修改条件导出绕过生产依赖。后续新增合同务必走带 `...` 的依赖构建或根构建。
- 构建体积门禁：首屏 JS 304.8 KiB / gzip 99.0 KiB，11 个 chunk，通过现有预算。Draco/glTF/watlas 的 Node 模块 externalization 与大 chunk 提示仍存在；构建通过不等于零构建警告或所有依赖分支都经过生产浏览器验证。
- 根启动/CLI/部署操作单元测试 16/16；native ops 聚焦与启动器 9/9。Web/API 仍在 Web 模式健康运行，未停服务。
- 11:02 最后复跑：四面板 32 组、Web 全量 1127/1127、Web 生产构建与 bundle-budget、1705 源文件尺寸和 diff 检查均通过。当前仍有待办，以上不是全项目最终验收声明。
