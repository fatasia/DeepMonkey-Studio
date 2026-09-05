# S1-002 数据中心语义模型编辑器

> 按模板 `docs/specs/TEMPLATE.md` 编写；执行者：夜间 GLM-5.3-Flash 或白天模型。前置：S1-001 已完成（合同/CRUD 已在 `069fa1d` 落地）。

## 0. 元信息

- 所属批次：S1 数据语义层
- 依赖：S1-001（已完成）；交互语言参照 EX 系列（术语/按钮等级/状态文案规范）
- 预估夜间时段：一整晚
- 觢触域：web 数据中心 + api（零新增后端）

## 1. 目标与用户故事

作为数据编辑者：数据中心新增「语义模型」页签，我可以选一个数据产品（数据集/管道）作为源，在其字段上新建/编辑指标（字段或公式 + 聚合 + 口径描述 + 默认过滤）、维度（字段 + 可选层级）、参数（类型 + 级联父 + 选项来源），保存时后端校验并给出行级错误提示，revision 自动递增。列表支持搜索、重命名、删除（删除有确认；被 2D 引用是后续 S1-003 的事，本规格删除仅确认自身）。

## 2. 现状与复用（执行前核对）

- 页面骨架：`DataCenter.tsx`（**645 行，红线**）四段 Tab（接入数据/处理逻辑/发布接口/高级接入）——新页签以**新组件文件**挂入，DataCenter 只加一行懒加载/挂载与状态最小侵入（≤15 行）。
- 表单先例：`DataCenterForms.tsx`（550 行）的 `ConnectionForm`/`DatasetForm`（动态字段、计算字段编辑器带 `compileFormula` 实时校验与依赖显示）——指标表达式编辑直接复用该编辑器组件（若不可直接复用则抽公共子组件，DataCenterForms 行数只减不增）。
- API 客户端：`apps/web/src/api.ts`（792 行，红线）——新增 `listSemanticModels/createSemanticModel/updateSemanticModel/deleteSemanticModel` 四个方法照抄 datasets 客户端方法模式（行数 +≤30；若超界则把数据类客户端方法抽到新文件 `apiDataAssets.ts` 并在 api.ts re-export，禁止复制既有方法）。
- 后端：S1-001 路由已就绪（`/api/projects/:id/semantic-models` CRUD，400 带分号连接的多错误信息，409 名称重复）——前端把 message 按"；"拆行显示。
- 管道源字段：合同要求管道源显式 `source.fields` 清单（S1-001 校验强制）；编辑器在选管道源时提供字段清单编辑（key/label/类型，行内增删），并提供"从最近预览导入"按钮（调 `previewDataPipeline` 取 fields 自动填充，失败显示原因）。

## 3. 合同设计

无新合同。UI 产物即 `SemanticModelRecord`（contracts `semantic.ts`）。

## 4. 实现要点

### 4.1 列表视图 `SemanticModelStudio.tsx`（新，≤300 行）

- 数据中心第五个页签「语义模型」；列表：名称/源产品/指标数/维度数/参数数/revision/更新时间，按更新时间倒序；顶部搜索 + 新建按钮。
- 空态：说明文案 + 「从数据集创建」「从管道创建」两个入口按钮。
- 行动作：编辑、重命名（行内或小弹窗）、删除（确认弹窗，列出名称）；409/400 错误按现有数据中心错误样式显示。

### 4.2 编辑器 `SemanticModelEditor.tsx`（新，≤400 行）+ 分块子组件

- 顶部：名称/描述输入 + 源选择（数据集或管道下拉，源切换提示"字段引用将失效"并保留用户已填定义、错误由校验标出）；管道源显示字段清单编辑器（§2）。
- 字段参考区：源字段 chips（key/label/类型），可折叠；点击字段可快速插入到当前聚焦的表达式/过滤字段输入。
- 指标区 `SemanticMetricList.tsx`（≤200 行）：卡片列表，每卡 = key/label/口径描述 + 聚合下拉（统一枚举六项，中文标签）+ 字段下拉或表达式编辑（二选一互斥，count/countDistinct 可全空）+ 默认过滤行编辑（字段/算子/值，增删行）+ unit/decimalPlaces（折叠"高级"）。新建按钮 + 删除 + 复制。
- 维度区 `SemanticDimensionList.tsx`（≤160 行）：key/label/主字段 + 层级编辑（有序行：字段+名称，上移下移增删）。
- 参数区 `SemanticParameterList.tsx`（≤180 行）：key/label/类型 + parentKey 下拉（其它参数）+ 选项来源（静态选项行编辑 / 维度下拉）+ 默认值。
- 保存：整模型提交（create/update），后端错误按"；"拆为行级映射显示在对应区块顶部（不做字段级定位映射，v1 整体列出即可）；保存成功 toast + 列表刷新；自动保存**不做**（与数据中心其余表单一致的手动保存语义）。

### 4.3 术语与状态

- 全部走数据中心既有术语/按钮等级/错误样式（`data-center-workbench.css`）；加载/空/错误三态齐全；删除确认与既有删除确认组件一致。

## 5. 测试计划

- `SemanticModelStudio.test.tsx`：列表渲染/搜索/空态/重命名/删除确认。
- `SemanticModelEditor.test.tsx`：新建完整模型（指标字段型+表达式型、维度层级、参数级联）提交 payload 结构正确；管道源字段清单编辑与"从预览导入"（mock api）；后端 400 多错误拆行显示；互斥（字段/表达式）切换 UI 状态；count 无字段可保存。
- api 客户端方法测试并入既有 api 测试模式（若 DataCenter 有客户端测试先例则照抄，否则在组件测试内 mock）。
- 门禁：`pnpm --filter @bim-studio/web exec vitest run src/components/SemanticModelStudio.test.tsx src/components/SemanticModelEditor.test.tsx && pnpm --filter @bim-studio/web typecheck && pnpm quality:source-size`。
- 浏览器：dev server 数据中心页截图（列表空态、编辑器完整填写态、错误态），双主题。

## 6. 验收标准

- [x] 第五页签可用；CRUD 全链真实 API 走通（保存后刷新恢复）
- [x] 指标字段/表达式互斥、count/countDistinct 免字段、聚合六项与后端枚举一致
- [x] 管道源字段清单可编辑、可从预览导入、失败有错误态
- [x] 后端多错误拆行显示；409 重名提示清晰
- [x] DataCenter.tsx 和 api.ts 均未超过全仓统一 800 行门槛；新业务模块按职责拆分
- [x] 聚焦测试、Web 全量、类型与生产构建通过；真实浏览器四组合通过（最新全仓门禁见交接 §14）

## 7. 风险与回滚

- api.ts 792 行逼近红线：优先评估抽取 `apiDataAssets.ts`；抽取必须 re-export 保持既有 import 路径不破坏（全仓 grep import 确认）。
- 编辑器复杂度高：三区各自独立子组件先行渲染只读态再接编辑，两步两提交。
- 回滚点：独立提交。

## 8. 完成回填（执行后填写）

- 2026-09-05 Codex：复用既有 CRUD/公式编译器，无新增依赖或后端合同。UI 拆分为状态编排、目录、指标/过滤、维度层级、参数/选项、管道字段与表单；保存手动，不改已发布页面。
- 专用 Chrome + 隔离生产 API 实测四组合（1440/980 × 深/浅）：完整定义、字段/表达式互斥、count 无字段、层级重排、级联参数、400 多错保留、409 重名、管道真实预览、重命名、删除取消/确认、搜索、保存后刷新恢复。产物 `test-output/codex-2026-09-05/semantic-editor-KYGmec/`。
- 真实失败反例驱动修复：数据中心切页卸载导致草稿丢失 → 首次懒挂载后隐藏保留；非默认项目刷新回默认项目 → `/data?project=...` 保留项目身份。返回列表/返回数据中心上级与浏览器离开有未保存提醒。未改原项目数据。
- 10 项新增聚焦测试、路由新增反例测试；Web 全量 1178（含新 UI）通过，路由修复后全量再跑。客户端测试与真实浏览器代替单独的 Studio 模拟交互测试；不是静态 DOM 存在即通过。
- 边界：本规格仅定义和管理语义模型；2D 消费、参数服务端求值、模型引用保护、并发 revision 冲突处理按后续集成继续验收，不能把定义 UI 当成分析运行闭环。
