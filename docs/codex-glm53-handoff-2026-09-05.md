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
| 1 | 报告回归保持 | 14:15，33 条在报告范围内均已修或复核关闭；逐项证据见复核表。新增项先复现；不要重做本轮修复，也不能把此状态当全项目验收完成 |
| 2 | Agent 深化与失败恢复 | 普通 AI 取消/后续草稿保护已修（§8），剩余 Agent 多候选名称选择、上游 504 恢复与跨项目异步返回；不要重做取消基础设施 |
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

## 8. 12:00 接续：Agent 目录与 AI 取消（已完成增量）

- 先读了 GLM 新提交 `0d49388`（只改其交接的素材瓶颈统计），没有覆盖并行修改。UI 原报告无新增；164 GLB 下载仍暂停，“zip 可增产三倍”只是 GLM 估算，不是本轮实测。
- Agent 原失败 checkpoint 仅有项目/场景，无数据集目录，且查询工具要求 datasetId。`industrialAgentDatasetCatalog.ts` 提供服务端当前项目目录，每次决策重新读取；最多 50 数据集/64 字段/约 40k 字符，截断显式标记。只带名称、字段、版本，不带 SQL/连接配置/样本行；经既有输入隔离检查，元数据仍不是执行证据。
- `industrialAgentDecisionProvider` 保留工具描述，优先目录/工具再放大场景快照，提示按字段匹配与数据集名称澄清。未自动绑定首个数据集，没有放宽审批或工具白名单。集成门禁用真实编排器/工具网关/受控查询插件，模型决策为确定性夹具，覆盖正常读取和越界/未知字段拒绝。
- `runAssistantRequest.ts` 抽取 BIM 准备/SQL 两阶段/流式读取，统一 signal 与每个 await 后检查。AiAssistantPanel 从准备前持有请求所有权，旧 finally 不影响新请求；增加停止按钮，发送时清空当前输入而不是结束时清空后来草稿；忙时禁止切模式，切项目/场景/脚本清旧会话。BIM 已准备证据在模型失败时仍保留。
- 服务器同族根因：HTTP 请求正文完成后 `request.aborted` 不再代表等待响应期间的断开；新增 `httpDisconnectScope` 同时跟踪响应 close，普通问答/SSE/Capability 均将 signal 传到提供方。正常响应完成不误取消；SSE 首事件前仍保留结构化 403 错误，关闭后不写迟到事件。
- 12:00 验证：Web 322 文件/1136 测试、API 113 文件/448 测试全通过；API build 通过。聚焦前端 12 项、API 28 项包括四条真实 HTTP 断开链路。AI 浏览器四组通过、UI 报告门禁双主题通过。构建最终结果见后续补记。
- 真实在线 Agent：原问题仅开放 plan/read 两个工具，已发现并校验“HTTP · 实时设备状态”；第二次模型决策上游 504，未完成数据读取及诊断。检查点 `a06d9fd8-320d-4167-95e2-bc83fcb56921` 保留，截图见 `ai-lifecycle/agent-live-discovery-provider-504.png`；原失败 `5fae5512-a669-4a5d-b89f-21c159b136cf` 未篡改。原场景未写入。
- **本轮待办**：Agent 当前失败都被视为终态，即使 failure.retryable=true，也不能从检查点恢复；不要自动重放写入，应另做严格受限的决策失败恢复规格/测试。Agent 启动/操作/轮询的过期响应也需继续收紧。多候选目前是模型按名称文字澄清，尚无选择卡片与续答机制。BIM 准备取消本轮为纯逻辑测试，未冒充真实大 BIM 文件专项浏览器验收。
- 对标采用：Copilot Studio 官方说明用上下文、工具说明和输入输出选择能力，缺信息先问，取消应停止计划剩余步骤；据此补的是目录、取消与明确证据，不复制竞品界面、不宣称全面超过。来源：[Microsoft Learn](https://learn.microsoft.com/en-us/microsoft-copilot-studio/advanced-generative-actions)。

复跑：`node apps/web/scripts/gate-ai-lifecycle.mjs`；产物 `test-output/codex-2026-09-05/ai-lifecycle/`。隔离浏览器只模拟 AI 响应，不调用真实模型、不改品牌设置；真实在线失败单独保留。

12:04 收口：Web/API 生产构建通过，首屏仍为 304.8 KiB / gzip 99.0 KiB、11 chunks，预算无回退；既有 Node 模块 externalization/大 chunk 构建提示仍在。1715 个源文件尺寸门禁与 diff 检查通过，全局 Web/API 健康；本批不再重复改 credentials、存储或下载。

## 9. 12:55 接续：拓扑视口与运行状态（已完成增量）

- P3-2 真实复现：980px 视口内宽 558px，5 节点只有 source 完整可见；不是 z-index 覆盖，而是 100% 固定初始比例 + 无 fit。`useTopologyViewport` 独立管理视角，按节点含端口/高度标记的投影边界适配；首次打开、切文档/投影与概览模式尺寸变化自动 fit，手动缩放/滚动后不强制复位。增加键盘可达“显示全部节点”，缩放保留中心，诊断/工具条不遮画布。
- 2.5D 的负投影通过画布原点偏移容纳；视角不写文档、不添加撤销记录、不触发保存。空拓扑首个普通节点在 980px 可能越界的同族问题由内存夹具复现，补概览模式结构变化适配。
- P3-3：服务端合同无改动，studio-core 派生统计新增 unknown；缺快照为“待数据”，明确 unknown 为“未知”，offline 为“离线”，不再合并计数。适配器空行/缺字段返回 unknown，明确 unknown 不再误判 running。真实读取失败的既有 offline 行为保留，不能扩大为物理设备离线诊断。
- 拓扑亮色页面原为硬编码深色，局部中性面、字段、诊断、边线对接平台令牌；告警语义仍独立。统计区抽取为小组件，主 View 行数下降。
- 对标采用：[React Flow FitViewOptions](https://reactflow.dev/api-reference/types/fit-view-options) 的节点边界、padding、缩放限值；[Grafana Node graph](https://grafana.com/docs/grafana/latest/visualizations/panels-visualizations/visualizations/node-graph/) 的视图导航与编辑布局分离。不引新图编辑器依赖、不以自动布局改原数据来掩盖裁切。
- 门禁：`node apps/web/scripts/gate-topology-viewport.mjs`，原项目只读 + DEV 内存 QA；1440/980 × dark/light，包含首次 fit、侧栏双向切换、层级投影、键盘 fit、手动视角、窗口变化、负投影、拖拽一笔/撤销、空态/首个节点/切文档。业务写入 0，控制台错误/警告 0。截图 `test-output/codex-2026-09-05/topology/`；最初脚本误把 2D 当切换钮，已改点击真实“层级”并断言 class，旧 failed 图不代表当前仍坏。
- 聚焦 Web 19 项、studio-core 全量 70 项、API 全量 448 项通过；Web 全量 1142 项通过，最终复跑/构建以本节收口补记为准。1721 源文件尺寸门禁通过。
- 下一直接工作：按用户最新“全部修复并整体再过一遍”要求，闭合复核表剩余条目及全站主流程。不能把本批局部通过当整个项目结束。

12:58 收口复跑：Web 323 文件/1142 项全通过、Web typecheck/生产构建通过；四组拓扑门禁含新增空态首节点通过；首屏 304.8 KiB / gzip 99.0 KiB 未回退，既有构建提示未消除。日志页 `vite` 关键词真实查询无 ANSI，截图已保留到 `report-final/service-logs-vite-dark.png`，下一批补双主题与失败态后关闭 P2-8。

## 10. 13:38 接续：最终 UI 报告复核（已完成增量）

- 最终 GLM 报告仍 33 条，32 条已修或复核关闭；只剩 P2-5 需要生产冷加载验证。不是全项目验收完成，Agent、SIM 深度和后续规格队列仍保留。
- `gate-ui-report-final.mjs`：1440/980 × dark/light 四组，真实登录和只读业务 API；长名称、剪贴板拒绝/恢复、真实拓扑预览、三主 CTA、健康键盘诊断、真实日志无 ANSI、能耗单列/CSV 边界、480 AI 芯片、未知路由通知/关闭均通过。业务写请求由拦截器阻止并作为失败记录；最终写请求 0，控制台错误/警告 0。截图在 `report-final/`。
- 发布的 updatedAt 是元数据变更时间；只改“最近变更/变更于”及说明，不回滚时间戳或改发布合同。长名称提供 60 字符建议而非虚构后端上限：200+ 字符仍保留，旧名称不丢失；辅助说明移出 label，通过 aria-describedby 关联，避免把说明变成输入的可访问名称。
- 拓扑卡片读取真实坐标/连线，250 节点/500 边预览封顶并注明；拥挤标签隐藏以免重叠，没有用自动布局修改原拓扑。缺边/空图/同坐标/负坐标有聚焦测试。
- 健康诊断从截断的 title 改为 details + 可复制 pre；设置页及 Study 的中性层换成现有主题令牌。截图目视发现而非仅 DOM 检测的另外两项：设置页亮色仍深底、运营标签保留旧 330px 侧栏空间；均已修。能耗 textarea 的 width:100% 加左右 margin 导致右边框裁切，同族修复为扣除边距。
- **额外真实缺陷**：运营中心挂载时不论页签都 POST `maintenance/sync-iot-nb`，开发 StrictMode 发两次；该处理会更新维护模型、并按条件清理旧 sample。首次回归已发出两次请求，用户已告知；未记录响应明细，不声称零维护记录影响，也没有无依据回滚。随后移除隐式同步，保留两个显式同步入口，当前四组合浏览无业务写请求，未写原场景。
- 基线回归 `gate-ui-report-20260905.mjs` 双主题复跑通过。第一遍 dark bootstrap 截图遇 Chromium `Unable to capture screenshot`，light 通过；单独重跑两组通过，没有为此改产品。另一次坏编码直连被开发服务器 404 拒绝，不把它作为正常未知路径 UI 失败。
- 13:30 Web 全量 325 文件/1148 测试、typecheck、生产构建、1726 源文件尺寸通过；首屏仍 304.8 KiB / gzip 99.0 KiB。13:38 全仓测试与最后构建正在复跑，结果见后续收口补记。

### 全服务检查与本机依赖恢复（接续中）

- Web/API/PostgreSQL/MinIO 一直健康。MediaMTX 按既有配置启动需要工作目录是仓库根（证书路径相对根）；从 tools/mediamtx 目录启动会找不到证书。已用根目录启动，端口 9997 探针健康，没改证书/配置/密码。
- Node-RED 并非只需启动：本机 tar@7.5.22 缺 `dist/commonjs/package.json`，@tdengine/websocket@3.5.0 缺两个 JS，got/cheerio/debug/long 也有缺文件。通过 `npm pack --ignore-scripts` 获取**锁定版本**官方发布包，SHA-512 integrity 与 pnpm-lock.yaml 对应记录一致，只恢复缺文件，不覆盖现有文件、不改锁文件或新增版本。Node-RED 的 `.data`/flows/凭据没有删除。
- tar 的两个模块类型声明用原发布内容补回；其他包采用经过目标路径校验的指定缺文件解包。属于本机 node_modules 安装修复，不应生成上游缺陷补丁：官方包本身包含这些文件。
- Node-RED 第一轮恢复后已监听但仍缺 http request 等节点，不能把 HTTP 200 当所有节点可用；13:38 按锁定包补齐后再次启动，下一步核对节点注册、实际 iframe/桥链路和服务健康。日志 `.runtime-logs/node-red-qa-20260905.*` / `mediamtx-qa-20260905.*`。

13:40 收口：全仓 `pnpm -r test` 通过（Web 1148、API 448，contracts 170，含其余包/Rust/Node-RED 静态校验）；最后 Web 生产构建与预算通过，首屏未回退。全站 UI 旧门禁双主题和新门禁四组合最终通过。Node-RED 已 Started flows，但额外发现 TDengine Function 的 finalize 使用裸 await（静态校验漏查生命周期脚本）以及 OPC UA 依赖 @peculiar/utils 的模块类型声明缺失；下一批优先清这两个实际错误，不能宣称 Node-RED 全恢复。P2-5 与其余主线继续执行。

## 11. 14:15 接续：Node-RED 实际恢复与生产加载（已完成增量）

- Node-RED 5 的消息/初始化 Function 可 async，On Stop 是普通函数；原 TDengine finalize 裸 await 启动编译失败，旧静态校验用 AsyncFunction 漏报。内置/导出两个例子同步改为先清 context 所有权，再调用 close 并处理同步异常/Promise 拒绝；不声称 Node-RED 会等待异步 close 完成。新增生命周期编译及幂等清理测试 2 项，34 内置/18 示例节点校验通过。
- 完成锁定官方包缺文件恢复，除前节外包括 lru-cache、@peculiar/utils；无新增依赖版本/锁文件变更。Node-RED 现进程 PID 24340，日志 `.runtime-logs/node-red-qa-20260905.validated.*`，Started flows 且 http request/OPC UA 可注册；保留上游 crawler deprecated 提示。TDengine/Oracle 示例触发器仍禁用，没有运行真实工业数据库查询。
- 真实额外缺陷：`fetchNodeRedHealth` 直接 fetch 未带平台鉴权，401 被伪装成 offline。改复用既有 ServerClient 鉴权/二次复核/取消通道；区分 loading、已确认 offline、检查失败，并允许键盘立即重试。复制权限失败有反馈，两个复制控件独立名称，反馈计时器卸载清理。
- 受信任同源 Node-RED iframe 原 sandbox 同时 scripts+same-origin 不构成隔离且触发 Chrome 警告，移除无效属性；未改鉴权、反向代理或访问范围。外框主题令牌化、980 网关单列、离线高度收敛；嵌入编辑器仍使用自身主题，不宣称跨 iframe 完整主题一致。
- `gate-node-red-runtime.mjs`：1440/980 × dark/light 四组，真实 admin/admin、编辑器和节点搜索、运行看板、复制权限拒绝/恢复、离线/503/键盘重试；0 业务写入、0 非预期控制台错误/警告，注入 503 单独记录。没有部署流程/触发工业数据库或广播 QA 消息，完整设备→场景链路不在这项证据内。
- P2-5 深测另确认：读取场景 API 前无反馈；错误时仅短 toast/进度停留。现在预览/发布统一 `ViewerLoadProgress`（fetching/essential/streaming/ready/error），未知进度不显示 100%，失败长期可见且可重载，基础几何场景正确进入 ready，旧异步模型错误不覆盖新任务。状态卡上移避开浏览工具栏，亮色重试按钮补实际对比度。
- `gate-production-load.mjs` 复用已有生产静态服务器独占 4174，结束关闭，不动 5173。禁用资源缓存、真实登录、本机 API/资源，无 CPU/网络限速；JS 请求被暂缓时 HTML 状态可见。双主题 × `/view`、`/published`，场景 API 暂缓/503/真实重试均通过，0 业务写入。
- 最后实测两小场景（预览 2 基础体、发布 1 基础体，外部模型均 0）：场景 ready 393–954ms，FCP 28–36ms。之前 279–395ms 仅 canvas 创建，已弃用为可用时间口径；不拿小场景证明大模型性能。截图 `test-output/codex-2026-09-05/production-load/`、`node-red/`。
- WebGL 发布不再无条件做 WebGPU 设备探测；WebGPU/cloud 候选保持原设备和作者效果保护。该场景 Windows powerPreference 警告已不再出现；ANGLE/Three X4122 数值精度 warning 在首次启动仍有 1 条，严格按原始文本单列，未压制产品 console 或伪报零所有警告。
- 验证：聚焦 Web 19 项通过；14:14 `pnpm -r test` 全仓通过（Web 327 文件/1155 项，API 113 文件/448 项，其他包与 Node-RED/Rust 通过）；Web typecheck/生产构建通过，首屏 304.7 KiB / gzip 98.9 KiB、11 chunks。既有构建 externalization/大 chunk 提示不变。质量尺寸与全服务检查见收口补记。
- GLM 原报告仍截至 10:01:16、33 条，未有新项。报告范围全部关闭不等于 §4 主线全部完成；下一步优先仿真真实运行/状态保留与 AI 恢复。admin/admin、存储、原场景、暂停下载不动，严禁 push。

14:17 收口：1733 源文件尺寸门禁通过（均 ≤800，无豁免），diff 检查无问题；`pnpm studio check` 确认 Web 模式、API 4100/Web 5173 健康。
