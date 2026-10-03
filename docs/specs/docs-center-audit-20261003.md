# 文档中心与 Wiki 镜像审计与修订记录（2026-10-03）

范围：`apps/web/src/docs/*.md`（审计时 32 篇）、`docsCatalog.ts`、`docs/README.md`。`README.md` / `README.en.md` 由另一条线负责，本次不动。`artifacts/wiki` 是导出镜像，只通过 `pnpm docs:wiki:export` 生成。

## 现状核查

### 已有（不重建）

- 渲染链：`packages/docs-runtime`（解析、搜索、链接校验）、`DocsCenter.tsx`、`DocsCenterCodeBlock`、`DocsSdkExamples`；`docsCatalog.test.ts` 已覆盖文章清单、链接、图片、渲染器兼容性与若干搜索用例。
- Wiki 导出：`scripts/sync-docs-wiki.mjs`（`--export` / `--check`），分类与顺序直接读取 `docsCatalog.ts`。
- 插图：`apps/web/public/docs-assets/` 的 4 张 SVG（流程图，不含界面文字，不受近期 UI 改动影响）。`generated/` 下的 PNG 未被任何文章引用。
- 近期能力的实现与规格：`docs/specs/*-20261003.md` 系列；本次以代码中的真实文案为准，规格只作线索。

### 渲染器的硬约束（直接影响写法）

`parseMarkdown` 只支持标题、段落、平铺列表、引用、代码块、分隔线、行内代码、链接和图片。**不支持粗体 `**…**`、表格、嵌套列表、HTML。** 审计时 8 篇文章共有 45 行带 `**…**`，在应用内会原样显示星号（Wiki 上则正常显示为粗体）。这是真实的显示缺陷，本次全部改为无标记写法。

### 逐篇审计发现的不准确之处（以代码核实）

| 文章 | 原文 | 实际 | 处理 |
| --- | --- | --- | --- |
| getting-started | 克隆后 `cd bim-studio` | 仓库 `fatasia/DeepMonkey-Studio` 克隆出的目录是 `DeepMonkey-Studio`（仓库根就是 `bim-studio` 的内容） | 改为 `cd DeepMonkey-Studio` |
| getting-started | 新建场景后"添加二维组件" | 新建对话框现有"初始内容"选项（示例本体 / 空白场景）；项目页还有"内置综合案例" | 重写首个场景步骤 |
| dashboard-scene / server-publish / troubleshooting | "查看流程" | 实际是场景页底部"展开开发流程"，交付校验入口为"交付校验 → 进入发布" | 改文案 |
| dashboard-scene | "聚焦可见组件" | "聚焦页面中的可见组件"（按钮提示） | 改文案 |
| server-publish | 场景卡"更多"含版本历史、复制场景、导出 | 版本历史与复制在卡片操作行；"更多"含查看发布版、复制发布链接、撤回发布、云渲染开关、删除场景；导出在编辑器"导出场景" | 改写 |
| server-publish | 发布选项"保持发布画质 / 允许极速模式" | 发布对话框为"选择交付方式（WebGL / WebGPU / 云渲染）"、"性能策略（高画质 / 极速模式）"、"浏览工具栏（显示 / 隐藏）"、"发布方式（仅发布 / Three WebView / Deep Native）" | 按真实界面重写 |
| server-publish / deep-engine | "页面下载 `.bimscene.zip`，Windows EXE 由客户端构建器生成""由发布运维命令完成" | 发布对话框选 Three WebView / Deep Native 后，发布完成直接下载 `<应用名>.exe`（`/api/.../native-executable`、`/three-webview-executable`）；需登录且非只读角色，Three WebView 依赖管理员配置的通用启动器 | 改写；命令行流程降为运维补充 |
| deep-engine | "更多 → 渲染诊断"，两种渲染器 | 菜单项为"更多 → 渲染引擎"，面板"渲染引擎设置"，三个目标：兼容模式（WebGL）、Deep WebGPU Beta、Deep WASM；切换前预检，失败自动回退 | 改写 |
| deep-engine | `artifacts/windows-portable/…` 随仓库提供 | 该目录是 `packages/deep-engine-native/scripts/package-windows-portable.ps1` 的本地输出（默认在 `packages/deep-engine-native/artifacts/windows-portable`），不入库 | 更正出处与路径 |
| engine-benchmarks | 一处断裂的链接括号 `[`test-output/…` ，runner…` | 渲染成错误文本 | 修正 |
| runtime-and-extensions | 本地工作台"需要在线数据、AI 或发布时再切换服务器模式" | 桌面"选择工作方式"页写明本地工作台支持数据源、AI、Native / Android 发布，项目可经 `.bimproject` 双向迁移 | 改写 |
| runtime-and-extensions / model-import | "Revit 导出依赖 Windows 主机上的 Revit；DWG 需单独安装 LibreDWG"，并把它们作为扩展接入 | 与工业格式硬门槛冲突：路线必须是自研 / 开源、内置、本地离线。外部转换器与源软件路径不计入内置能力 | 重写格式边界；见下文 |
| model-import | 未提 JT、X_T | 内置：JT 9.5 / 10.3 LOD0 子集、X_T 旋转件子集 + 通用文本解析降级档；STEP 经 `occt-import-js`；OpenUSD | 补全并标明边界 |
| ai-workflows | "平台 AI 助手"仅区分"问答与生成 / 执行任务"，未覆盖新交互 | 头部会话下拉、"对话 / 执行任务"分段按钮、"本次上下文"折叠、可用能力折叠、输入框内"提问范围"与模型下拉、执行方式三档 | 重写 |
| deployment-operations | "系统管理 → 通知与推送" | 入口是"设置 → 通知与推送" | 改文案 |
| ai-modeling3d-api / api-reference | "系统 → AI 与模型 → 3D 生成模型" | 入口是"设置 → AI 大模型 → 3D 生成" | 改文案 |
| troubleshooting | 恢复对话框标题"发现未完成的本地修改" | 标题为"恢复未保存修改"，提示语"本地修改尚未保存 / 服务器已有更新版本" | 改文案 |
| troubleshooting / behavior-script | "应用修改并运行" | 脚本面板按钮是"试运行"（`Ctrl+Enter`） | 改文案 |
| data-pipeline | 入口"数据" | 项目工作台"平台能力 → 数据中心" | 改文案 |
| data-pipeline | "高级接入" | 界面无此入口，只有连接表单里的"高级连接策略" | 删除该句 |
| industrial-planning | "运行流程仿真" | 按钮是"运行仿真" | 改文案 |
| media-widgets | 断流提示"正在重连" | 实际为"信号中断，正在自动重连…" | 改文案 |
| community | 内容版本 `2026.09` | 本次修订后升至 `2026.10` | 同步 |
| container-deployment | 链接文字"从零开发与原生部署" | 指向的文章标题是"部署与系统运维" | 同步 |

### 近期落地能力的文档缺口

| 能力 | 代码依据 | 文档处理 |
| --- | --- | --- |
| AI 助手新交互 | `AiAssistantPanel.tsx`、`AiAssistantSessionControls.tsx`、`AssistantModelControls.tsx`、`IndustrialAgentWorkspace.tsx` | ai-workflows 重写；faq、troubleshooting 补条目 |
| 新建场景默认示例本体 / 空白场景 | `SceneManagerDialogs.tsx`、`controllers/defaultSceneSample.ts` | getting-started、dashboard-scene |
| 资产陈旧提示、更新 / 保持当前、删除影响面 | `ProjectAssetInventory.tsx`、`SceneManager.tsx`、`delivery/assetDeletionImpact.ts` | resource-workflow、troubleshooting |
| 模型动画根运动开关 | `ModelAnimationControl.tsx`、`viewerEngineRootMotion.ts` | 新文章 scene-effects-rendering |
| 火焰图层：曲线、预算、透明排序 | `ModelEffectsEditor.tsx`、`viewer/modelFireParticles.ts` | scene-effects-rendering；deep-engine-sdk 的 `./particles` |
| 体积雾与散射反照率 | `ScenePostProcessingEditor.tsx` | scene-effects-rendering |
| 物理固定步长确定性 | `physicsWorldHost.ts` + `FixedStepClock` | scene-effects-rendering；deep-engine-sdk |
| 物理光照出图（CPU 路径追踪）、HDR 与回执 | `PathTraceAuthorDialog.tsx` | scene-effects-rendering，只写已确认部分 |
| three 与 Deep 共享显示合约、`pnpm gate:parity` | `contracts/displayContract.ts`、`scripts/gate-parity.mjs` | deep-engine、deep-engine-sdk、engine-benchmarks |

### 仍在进行中，刻意不写成已支持

World API（reset / step / observe）、路径追踪的多线程并行与 PNG 导出（界面代码已存在，但验收未完成，只在边界里一句话提示）、Deep 描边、sheen / iridescence 材质、助手"计划 → 执行 → 验证"闭环、模型路由。Python SDK 不做，文中不出现。

### 结构与阅读顺序

- 原"快速开始"分类混入了 4 篇引擎文章（Deep Engine、SDK、设计来源、基准），新手读完核心概念后会直接落入引擎内部。新增"三维与引擎"分类，把它们和新文章 scene-effects-rendering 放在一起；"快速开始"只保留安装、核心概念、首个场景、运行方式。
- 新手路径调整为：安装 → 核心概念 → 首个场景 → 运行方式（快速开始）→ 资源与导入模型 → 数据中心 → 预览与发布 → 故障恢复。`order` 重排，文章 ID 不变，已有的 `/docs/<id>` 链接全部继续有效。
- 文档内容版本 `DOCS_VERSION` 由 `2026.09` 升为 `2026.10`。

### 写作层面

- 去掉空洞收束句与"本轮新增能力"这类流水账式标题（deep-engine-sdk），改成按主题组织。
- 工业格式统一写作 X_T / `.x_t`；强调内置、本地离线，外部转换器只作为"部署方自备、不计入内置能力"的说明出现。
- 不再出现"资源库""资源中心"等被测试禁用的称呼。

## 校验记录

见文末"实施结果"。

## 实施结果

### 改动的文章

新增 1 篇：`scene-effects-rendering`（三维效果、环境与物理光照出图），放在“资源与编辑”分类。

重写：`getting-started`、`ai-workflows`、`server-publish`、`deep-engine`、`troubleshooting`、`faq`；`deep-engine-sdk` 的后半部分由“本轮新增能力”改为按主题组织。

局部修订：`dashboard-scene`、`core-concepts`、`resource-workflow`、`model-import`、`runtime-and-extensions`、`data-pipeline`、`engine-benchmarks`、`engine-design-influences`、`behavior-script`、`industrial-planning`、`media-widgets`、`deployment-operations`、`container-deployment`、`ai-modeling3d-api`、`api-reference`、`sdk-api-overview`、`contributing`、`community`。

其余文章（`studio-api`、`sdk-examples`、`agv-runtime-simulation`、`simulation-commissioning`、`topology-resources`、`open-source-assets`、`on-demand-packaging`）逐篇通读，文中引用的界面文案经脚本比对在代码中都能找到，未发现需要更正的内容，没有改动。

目录：`docsCatalog.ts` 增加新文章与“渲染引擎”分类，`order` 重排，`DOCS_VERSION` 升为 `2026.10`；`docsCatalog.test.ts` 同步文章清单与分类顺序，把“接入商业扩展”改为“可选适配器与内置能力的边界”，并新增两条渲染器兼容断言（无粗体、无缩进嵌套列表）；`DocsCenter.test.tsx` 的版本号同步。

仓库文档：`docs/README.md` 重写索引；`docs/wiki-mirroring.md` 更新篇数、分组数与写作约束；`docs/capabilities.md` 补充近期能力，并把 RVT / DWG 标注为非内置的可选路径，删除一个指向已移除文件的失效链接。

### 校验

- `cd apps/web && npx vitest run src/docs src/components/DocsCenter src/components/DocsSdkExamples`：6 个文件、36 条测试通过。
- `packages/docs-runtime` 的 vitest：1 个文件、5 条测试通过。
- `node --test scripts/sync-docs-wiki.test.mjs`：2 条通过。
- `pnpm docs:wiki:export` 后 `pnpm docs:wiki:check`：33 篇通过；`artifacts/wiki` 已重新导出（Home、_Sidebar 为 7 个分组）。
- `cd apps/web && npx tsc --noEmit -p .`：与文档相关的文件无错误。
- 相对链接核对脚本：`docs/README.md`、`docs/wiki-mirroring.md`、`docs/capabilities.md` 的相对链接与锚点全部存在；文章内 `/docs/<id>#<锚点>` 由 `docsCatalog.test.ts` 的链接校验覆盖。
- 应用内截图：审计时 dev server（5173）因他人在途改动（`useAppRuntimeEffects.ts` 缺少 `../delivery/sceneDeformedModels`）无法加载页面，未能完成 `/docs` 的浏览器截图；改以解析器结构断言代替（无表格、无粗体、无嵌套列表）。

### 遗留

- 路径追踪的多线程并行与 PNG 导出：代码已在仓库中，但验收尚未完成，文章只在边界里点明，待验收后补写。
- `docs/native-deployment.md` 里的克隆目录仍写作 `bim-studio`（与 `git@github.com:fatasia/bim-studio.git` 对应的旧仓库名），不在本次范围，未改动。
- `docs/capabilities.md` 里“脚本可直接访问 Three.js、ViewerEngine 与全部运行时对象”等历史描述与当前 Worker 脚本模型不一致，建议单独清理。
- 应用内文档目前只有中文；界面语言可切换，但文档不分语言。
- 一致性门（`pnpm gate:parity`）的规格被他人更新过（透明场景口径修正）；文章已按更新后的口径写，但规格与基线仍可能继续变化，引用具体数字时请以 `docs/specs/parity-gate-20261003.md` 为准。
- 他人在途的改动已使 `c8-shared-scene-parity` 失败（`contactShadows` 默认值变化），与本次文档无关，文中没有引用该门。
