# 接手入口：当前真实进度与未提交现场

更新时间：2026-09-05，本文件先保存检查点，最终测试/提交后继续更新。

## 最终接手状态：额度仅约1%，优先读本节

最终追加：卡片补丁已提交`1efd53b`，最后Web生产构建与1256项全量再次通过（日志codex-final-layout-*）。ASSET-002最后两组浏览器正在执行，日志`.runtime-logs/codex-model-asset-context-layout-final.log`；只以该最终结果和规格回填判定新卡片布局，不用旧9SL8Cf视觉结论替代。

账户23:59前最后读取已用99%，未兑换reset。**主体源码已经本地提交c77c503**；下面早期“源码未提交”的段落属于过程记录，以本节为准。后续卡片布局/规格文档另作收口提交，查看git log；绝未push。

**已完成**：全仓1256 Web/494 API与其他包测试、根typecheck/1885源文件尺寸、生产构建307.2KiB/gzip99.8。作者隔离LE9JXj、语义最终q9ezkE、SIM最终2R3HHn、公开应用相邻si3ojN、优化链最终iXV4T5均已通过限定真实浏览器验收；各门禁和准确边界在EX-005、S1-003、SIM-001§9、SIM checkpoint中。API/正常Web继续健康，没有改原数据与账号。

**本轮待办（接手第一步）**：ASSET-002新上下文链的两组功能门禁9SL8Cf已通过（含保存503留页、关autosave仍不改、入库定位、返回新增、撤销重做和真刷新恢复）。但目视发现新卡片操作按钮撑破原5列，已补actions容器和局部4列/窄窗折行、亮色标题令牌，最终生产重建与Web全量正在运行，日志 `.runtime-logs/codex-final-layout-build.log` / `codex-final-layout-tests.log`。最后需要重跑 `node apps/web/scripts/gate-model-asset-context.mjs` 两组并目视项目卡片；代理若赶上会更新ASSET-002，若额度中断不得自行宣布最后布局已验收。

**已确认但未修、下一最高优先**：小模型聚焦仍显示过小，`viewer/viewerEngineRendering.ts`的focusBox固定半径≥0.5、距离≥2，另有cameraConstraints.minDistance默认0.5。首次新增已调用focus但不解决底层限制，最新iXV4T5发布截图仍是小模型；不是模型缺失或缩略图错误。应按真实尺寸/近裁面/用户约束设计显式聚焦并加毫米→建筑尺度测试，不改原模型scale，不粗改所有相机。3D旧亮色输入/标签也还有硬编码，继续列门槛缺口。

剩余总体队列仍见下文：真源码调试、AskData语义与发布治理、实例替换合同、SIM停靠/历史回放/连续AGV/热力/其他仿真域统一、AI-2～5、16.7ms/大模型/短稳、长职责文件、300页面/10深行业包、SDK外部消费者及最终全站验收。**这些都没有完成，不要把此检查点当作所有任务完成声明。** 旧单场景`/published`仍需登录，匿名证据是`/apps`。

## 23:36 收口更新（优先于下面早期中间态）

- **已完成（统一检查）**：根`pnpm build`含所有包与API生产import烟测通过；首屏307.2KiB/gzip99.8。根`pnpm test`全部通过，Web354文件1250项/API119文件494项；根typecheck/1882源文件≤800通过。完整结构扫描56文件>500、生产TS/JS函数276个>80，仍有职责治理空间。
- **已完成（全仓发现的修复）**：优化器资源读取已归统一viewerAssetTransport并保留取消/超时；Agent时间预算超时与系统时钟毫秒误差造成“已耗尽但记录999/1000ms”不一致，固定计时反例红→绿，超时时计入完整预算，16项编排测试通过。不以修改断言容差掩盖状态矛盾。
- **已完成（语义最终）**：`semantic-consumers-q9ezkE`四组合/38聚焦、查询草稿不提前改变KPI、父→子查询/重置、稳定钻取/版本确认，最终20图已人工检查，0意外控制台错误/警告；隔离进程全部关闭。S1-003最终回填覆盖旧IwAkFl待测状态。
- **已完成（优化发布限定链路）**：`optimizer-workflow-JBFVMv`四组合完成真实新增场景/指定优化模型载入/保存刷新、真实应用发布、公开应用匿名署名与旧场景已登录隐藏工具栏署名，全部业务只读。每组作者页29/29 Worker关闭。**重要边界**：旧`/published/:sceneId`壳层仍要求登录，未为了测试扩大认证；不能称匿名场景UI已闭环，公开应用`/apps/:id`才是匿名浏览证据。
- **本轮待办（最终补丁）**：人工截图发现小零件未聚焦而显得极小。场景载入改为仅首次显式新增时focus，silent恢复不抢已保存camera；门禁亦补真实双击聚焦/稳定帧后保存。ASSET-002门禁又实际发现撤销/重做误弹本会话恢复副本，正在根因修复，需重建/复跑。上述1250/494是这些最后小补丁之前的全量，不可偷换。
- **本轮待办（集成提交）**：源码尚未统一提交；主代理等待SIM四组与ASSET-002恢复补丁验收。剩余约8%账户用量为23:31读取，未兑换reset。各组不再扩scope。

## 固定约束

- 仓库 `D:\Documents\bim\bim-studio`，分支 `dev-studio`。外层不是本轮提交目标；严禁 push。
- 不改 `admin/admin`、`.env`、PostgreSQL+MinIO 拓扑、原场景和用户项目。Web 模式，API4100/Web5173；本轮 `pnpm studio check` 仍健康，PID46300。不要为跑门禁重置正常数据或改密码。
- 用户允许直接修复、能并行尽量并行；也明确要求用量将尽前完整交接。最新读取账户周窗口已用86%，剩余约14%（账户共享，不是本任务专属，后续会变化）；没有使用剩余的重置额度。
- GPT/GPT6接入暂停；两项定时任务保持PAUSED。§28明确排除仍适用，不因“极致”扩大成认证动力学、OLP、8小时GPU浸泡等承诺。
- 先读根AGENTS、`codex-glm53-handoff-2026-09-05.md`最新章节、各规格回填和git status/log。保留未提交改动，不能重新实现/覆盖它们；后面的“已完成”是限定批次，不是整个项目完成。

## 本地提交基线

当前可核对的提交：`0967ef6`（Agent明确数据集选择/有界恢复）、`146aa83`（真实素材审核入库）、`b57a208`（原子下载校验）、`9c6de91`（公开页亮色对比度）、`817cb69`（正式发布应用运行）。均未push。

本文件写入时，优化器、作者运行、语义消费者、SIM后续仍有**未提交源码**。主代理负责最后按确切路径集成；不要 `git add -A` 混入缓存、密钥、其他用户文件，不要删除工作树来“回到干净状态”。

## 已完成：本轮已验证的增量

1. **素材2项真正入库**：平行机械夹爪/黄黑工业防撞柱，真实GLB、正确PNG、模型/图哈希、作者与CC-BY-4.0核对；新增2项，旧164项仍待审，缓存共166。`source-b-library-pUMxr4`四组；`source-b-render-SyNc6Q`两模型×双主题×双宽度8组。完整证据见交接§20及ASSET-001；不要把166说成全部已审核。
2. **Agent选择和恢复**：数据集候选明确确认，429/502/503/504决策失败最多3次手动同检查点恢复，revision冲突/工具副作用/取消不误重放。`agent-recovery-ea2f0X`四组截图，真实编排/查询集成另有测试，不是在线LLM成功承诺。已提交0967ef6；AI-2～5没有自动完成。
3. **优化器可靠性与来源**（尚未提交）：Worker终止/迟到文件读取、取消轮询、失败换源保留原结果、结果参数指纹、重复优化另存、取消保存后复用同上传回执；保留原始GLB动画与asset.copyright。服务端仅从当前项目合法源模型继承optimization来源，衍生物不占用公共目录dedup身份。预览GPU资源/位图/PMREM目标释放；PBR环境反射默认开启避免金属全黑。主组件约800→312行，烘焙UI与状态按职责分离。`optimizer-workflow-znjT1z`四组通过、每组17/17 Worker关闭，抽样暗5.53/亮4.56，最终浅色980/烘焙1440截图已人工检查。
4. **作者脚本运行隔离**（尚未提交）：私有ApplicationPlaybackSession/真实2D与3D预览，当前/全部启用、固定1/60生命周期单帧、停止保稿、依赖迟到取消、私有页跳转/外链提示；不写作者文档/视口。旧直接写入通道删160行，controller563→403。最终`author-script-runtime-LE9JXj`四组、每组6/6 Worker释放、运行0 PUT/显式保存1 PUT，3D实际青色像素验证；相邻`script-editor-aU1HPs`/`script-playback-81tvnw`各4组、80聚焦。**真源码断点/调用栈未做**，不能把生命周期暂停说成Unity调试器。EX-005已回填。

## 本轮待办：当前已落盘但还在验收/接线

### A. 语义消费者（代理 semantic_consumers）

`S1-003-semantic-dashboard-consumers.md`。指标/维度/层级/参数按modelId+revision引用，真实取数/聚合/同模型AND联动/下钻回根/动态级联/口径失效重确认已实现。首轮`semantic-consumers-IwAkFl`四组通过；人工截图又发现参数查询浮层一直加载，已补独立draftFilters选项求值与父→子批量参数顺序，38聚焦通过。**这一追加修复等待统一Web重建后重跑gate**，不能沿用旧bundle作最终证明。

共享`DashboardPlayback.tsx`导出PlaybackView并保留指标rows；`ApplicationPlaybackState.ts`的参数清理由语义组维护，不能回退作者组对Session的改动。AskData尚未接入；公开数据授权/语义发布快照、服务端引用删除/并发治理、参数全类型矩阵仍待办。

### B. SIM-1a（代理 agent_recovery，正在接线）

独占simulationEntities/plantLiteModel合同、AppStudioViewport和时间线SIM接线。当前flowNode/源汇队列工序字段、场景编译/导入重绑已落盘；运行→动态覆盖层→同一Study→单一时间线播放尚未完成统一验收。详细中间态由`SIM-1a-in-progress-checkpoint-2026-09-05.md`补充。复用PlantLite引擎与Playback，不写第二算法、不把瞬态混入场景原模型transform。

### C. 公开署名与模型入场景发布（主代理）

新增`delivery/PublishedModelCredits.tsx`与CSS/2个单测；公开应用和独立SceneViewer已接，AppStudioViewport由SIM代理补接。只展示实际引用模型，浏览工具栏隐藏时署名仍可达，Esc可收起。两单测通过；**待统一生产构建/真实浏览器**。

`gateOptimizerPublication.mjs`接到`gate-optimizer-workflow.mjs`末段：继续真实优化结果→新建场景→选模型载入/保存/刷新→真实应用发布→匿名应用与隐藏工具栏场景署名。刚写成、尚未跑；如失败先区分夹具/产品，不将之前znjT1z算作已覆盖此段。

### D. 用户最新追加：模型浏览/优化/场景导入无缝衔接（代理 script_author_runtime）

正在实施`ASSET-002-contextual-model-workflow.md`：素材卡片直达指定模型预览/优化；URL保留项目/模型及受限返回上下文；场景入口明确“保存并优化”，保存失败留原页；优化另存新素材→定位新ID→返回原场景新增载入/选中/一笔历史。不允许任意redirect或错误项目回写。

**已查明限制**：当前SceneModelState.modelId同时是资源身份，尚无assetId/instanceId分离；deleteModel会删除项目资源，绝不可用作“替换实例”。只有保留transform/脚本与仿真引用且一笔可撤销才可开放替换。当前批次不伪造替换完成，应明确提示并保留待办。

该组获准修改appRoute、素材库/SceneManager入口、ModelOptimizer/session与AppPlatformRoutes；主代理此前优化改动已冻结请保留。AppStudioViewport/SIM文件归B组。具体文件以git diff及ASSET-002为准。

## 项目剩余门槛（不得因局部通过划掉）

- 编辑器：真源码调试器、细分BIM稳定ID挂载、同屏编辑运行细节与全工作区保稿回归；当前已有自动生命周期，不退回以手动运行替代。
- 数据：AskData同语义消费、语义治理/发布策略、页面级联动总控与复杂参数/跨源联动。
- 模型：上面C/D最后链路、glTF ZIP等未覆盖格式、更多许可合格且视觉核对的资源；旧164项仍待审。工业格式真实转换验收按§28排除。
- 仿真：SIM-1a闭环/停靠自动隐藏，再按SIM-001做1b工位机器人、1c虚拟调试、1d What-if；四面板和静态路径不等于全部完成。
- AI：AI-UP中AI-2预测维护工单/通知/复检闭环、AI-3看板资产化、AI-4脚本会话化/3D草案、AI-5评测。固定夹具不代表客户或在线模型正确性。
- 性能：既有生产夹具P95约21ms，33.34ms门槛通过但**16.7ms目标未达**；真实大模型、短稳/内存资源、设备丢失恢复未全验收。优化预览仍连续RAF，本批资源释放不等于按需渲染性能完成。
- 代码：最后完整结构审计待重跑，旧基线58+长文件/大量>80行函数仍须按职责治理，≤800只是上限，不代表可维护性全部合格。
- 行业/组件/SDK：S3-B/C真实深度交付、≥300业务区分页面/≥10行业深度包未达；现有120模板不等于120深度包，禁止换颜色改标题充数；外部消费者安装/调用/打包SDK闭环待验。
- 最后全站：完整测试/构建、真实深浅1440/980、失败重试/无权限/空态、保存重载/发布历史回滚、相邻编辑器/资源/数据/仿真统一回归。既有UI报告33项已复核或修复，但新功能需新证据；不能说全平台已经超过ThingJS/Unity/Siemens。

## 立即接续顺序与命令

1. 先收B/D组可构建状态，再统一构建一次。正在跑门禁期间不要清理/重建共享`apps/web/dist`，隔离浏览器也从它读取；不要多代理同时build。
2. `pnpm --filter @bim-studio/api build`，`pnpm --filter @bim-studio/web build`。注意包名不是@bim/api。上次稳定构建22:58:58成功，首屏307.0KiB/gzip99.7；**后续新增代码不在这个bundle内**。
3. 并行跑 `node apps/web/scripts/gate-semantic-consumers.mjs`、`node apps/web/scripts/gate-optimizer-workflow.mjs`、ASSET-002和SIM新增gate；隔离服务必须全部退出，目视截图才给结论。
4. `pnpm typecheck`、`pnpm test`、`pnpm build`与完整结构扫描；根测试包括API/Web/contracts/其他包。前一已提交素材批次全量Web1210/API466只是旧基线，不等于这一大批最终全量结果。
5. 处理失败、回填各规格/总账/交接；精确stage源码测试文档，检查diff --cached，再本地commit。截图/log/缓存默认gitignored，保留本地，勿加入密钥/运行数据。

### 工具注意

浏览器使用隔离Chrome门禁和真实点击/键盘，DOM仅只读检测；不得调用旧u19d门禁读取浏览器token或改原场景。PowerShell的rg路径不展开通配符：用`rg -n -g '文件*.tsx' 'pattern' 目录`，先`rg --files`定位真实文件，不猜不存在路径。源码只用apply_patch修改；所有命令workdir明确内层仓库。

## 项目价值分析交付

SemaPLC/Astral3D分析已完成，见`semaplc-astral-value-analysis-2026-09-05.md`。SemaPLC借鉴PLC验证/Study证据链；Astral解析服务借鉴格式转换状态机与元数据约定，不等于直接复制所有格式能力或引入未经核实许可二进制。接手不必重复建设该研究。
