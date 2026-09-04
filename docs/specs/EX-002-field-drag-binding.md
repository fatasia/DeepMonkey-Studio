# EX-002 2D 字段拖拽绑定与数据面板（山海鲸槽位模型）

> 按模板 `docs/specs/TEMPLATE.md` 编写；执行者：夜间 GLM-5.3-Flash 或白天模型。依据 `docs/editor-interaction-benchmark-2026-09-04.md` §2 EX-002 与数据域摸底（2026-09-04）。

## 0. 元信息

- 所属批次：EX-002（依赖无；与 S1-002/S1-003 的关系：本规格先在现有 dataset/pipeline 数据产品上落地槽位交互，S1-003 语义模型绑定再叠加为第三种数据来源，复用同一槽位 UI）
- 预估夜间时段：一整晚（大件，可拆两晚：002a 数据面板+槽位渲染，002b 拖拽与联动）
- 触碰域：web 2D 工作区

## 1. 目标与用户故事

作为 2D 编辑者：选中图表组件后，右侧「数据」区显示**字段槽**（维度槽、指标槽、系列槽，按组件类型呈现）；画布右缘可展开**数据面板**，列出项目数据产品及其字段；**从面板把字段拖进槽位即完成绑定**，槽位右侧 X 解绑；类型不匹配的槽位标红拒绝。不再需要"下拉选产品→下拉选字段→点角色按钮"三段式。

## 2. 现状与复用（执行前必须先读文件核对）

- 绑定现状：`DashboardInspectorData.tsx`（**760 行，红线禁止增行**）：数据产品选择（`dataset:`/`pipeline:`）、字段下拉、角色分配（"一键角色"在 171-274 行附近）、报表/地图/直连分支；写入 `SceneDashboardWidgetState`（contracts `dashboard.ts`：`datasetId/pipelineId/field + analysis{dimensionField,measureField,seriesField,...}`）。
- 运行态取数：`DashboardWidgetRuntime.tsx` 的 `useDashboardMetrics()` 已按产品轮询并把行交给 `dashboardAnalytics` 聚合——本规格**不改运行态**，只改设计态交互，产物仍是同一份 analysis/datasetId 配置。
- 目录获取：`api.listDatasets` / `api.listDataPipelines`（DataCenter.tsx 的 load 模式）；字段 = `dataset.fields + computedFields`（管道字段无静态清单，面板中管道条目显示"字段需运行后可知"，允许展开时调用 `previewDataPipeline` 取 fields——失败显示错误态，不阻塞面板）。
- 拖拽先例：资源库卡片自定义 MIME `application/x-bim-dashboard-component`（`DashboardComponentLibrary.tsx:335-338` + `DashboardWorkspace.tsx:610-633` 的换算/落点模式）——字段拖拽照搬此模式，MIME 用 `application/x-bim-data-field`，payload `{ productKey, fieldKey, fieldType, label, unit }`。
- 数据产品语义角色重映射：`dashboardDataProductReplacement.ts` 已有 measure/dimension 按类型回退——槽位类型校验沿用同一字段类型体系（DataFieldType）。
- 检查器 tab 编排：`DashboardInspectorSelection.tsx`（88 行）。

## 3. 合同设计

无 contracts 变更（槽位是 `analysis` 既有字段的交互投影）。新交互产物等价于现有配置，保存/迁移/发布链路零改动。

## 4. 实现要点

### 4.1 数据面板 `DashboardDataPanel.tsx`（新，≤250 行）

- 位置：画布右缘竖向手柄（与左右面板收起按钮同一交互语言），点击滑出 300px 宽面板；记忆展开状态（localStorage 键沿既有偏好模式）。
- 内容：数据产品列表（数据集/管道分组，名称+字段数）；展开产品显示字段列表（key/label/类型图标/unit）；顶部搜索框（按产品名与字段名过滤）；刷新按钮。
- 字段条目 `draggable`，dragstart 写入 MIME payload；面板自身也是放置目标之外的普通区域，不与画布拖放冲突。
- 空态：无数据产品时显示"数据中心还没有数据产品"+ 跳转数据中心入口。
- 错误态：管道预览失败按条目显示"字段获取失败：原因"，可重试。

### 4.2 字段槽 `DashboardFieldSlots.tsx`（新，≤220 行）

- 选中数据类组件且检查器处于数据区时渲染。槽位集合按组件类型映射：
  - chart：维度槽（dimensionField，string/datetime）、指标槽（measureField，number）、系列槽（seriesField，string，可选）
  - value/gauge：指标槽（field，number）
  - table/report：沿用现有报表字段多选 UI，不强行槽位化（本轮不动）
  - map/filter/video 等非数据槽组件：不渲染
- 槽位渲染：已绑字段 chip（label+unit+类型图标+右侧 X 解绑）；空槽显示虚线占位（"拖入维度字段"等文案，`title` 说明）。
- **双向同步**：chip 与现有字段下拉/角色按钮是同一状态的两个视图——本规格把 InspectorData 的字段选择区替换为槽位组件渲染（InspectorData 行数只减不增，超界部分逻辑移入新文件）；任何经由槽位的变更走既有 `assignAnalysisField`/`selectDataProduct` 命令通道（在 `dashboardContentController.ts`，核对函数名）。
- 数据产品未选时：槽位区顶部显示产品选择（复用现有产品下拉组件逻辑），选定后槽位激活。

### 4.3 拖拽与类型校验

- 画布级 drop 处理： Inspector 槽位与面板都在 React 树内，槽位 `onDragOver`/`onDrop` 直接处理（不需要画布中转）；校验 payload.fieldType 与槽位期望：不匹配 → dragover 时槽位 `.is-rejected` 红框 + drop 拒绝并 toast/内联提示"类型不匹配：需要数值字段"；匹配 → drop 即绑定（走既有命令，可撤销）。
- 从槽位拖出（解绑后拖到别处）：v1 不支持（X 按钮解绑即可），回填记录。
- 同一字段拖入已占用槽位：替换（一条命令）。
- 系列/维度多值（报表类）不在本轮。

### 4.4 键盘可达性

槽位聚焦后可用方向键在槽间移动，Enter 打开字段选择弹出层（列表内上下选择+Enter 确认，Esc 关闭）——保证纯键盘可完成绑定（无障碍门禁要求）。弹出层复用既有下拉弹出样式。

## 5. 测试计划

- 新 `DashboardDataPanel.test.tsx`：产品/字段列表渲染、搜索过滤、空态、管道预览失败错误态、字段 dragstart payload。
- 新 `DashboardFieldSlots.test.tsx`：各组件类型槽位映射；drop 匹配类型→analysis 字段更新（断言既有配置结构）；drop 类型不匹配→拒绝且配置不变；X 解绑；键盘 Enter 弹出层选择路径。
- `DashboardWorkspace.test.tsx` 回归：数据绑定相关既有断言不回退。
- 门禁：`pnpm --filter @bim-studio/web exec vitest run src/components/DashboardDataPanel.test.tsx src/components/DashboardFieldSlots.test.tsx src/components/DashboardWorkspace.test.tsx && pnpm --filter @bim-studio/web typecheck && pnpm quality:source-size`。
- 浏览器：dev server + `?__visualQa=dashboard`，选中图表组件截图（空槽占位、已绑 chips、类型拒绝红框、数据面板展开态），双主题 × 1280/1440。

## 6. 验收标准

- [ ] 数据面板可展开/收起、搜索、空态/错误态正确，展开状态记忆
- [ ] chart 组件拖字段入维度/指标/系列槽即完成绑定，配置结构与既有完全一致（保存→刷新→恢复）
- [ ] 类型不匹配槽位标红拒绝且有明确反馈；X 解绑可撤销
- [ ] 槽位与既有下拉/角色按钮双向一致；纯键盘可完成一次绑定
- [ ] `DashboardInspectorData.tsx` 行数不增加；新文件 ≤250/220 行
- [ ] 全部测试 + typecheck + quality:source-size 通过；浏览器截图证据

## 7. 风险与回滚

- InspectorData 760 行的替换式改造风险最高：先做只读渲染（槽位=现有配置的展示+X），确认测试绿后再接 drop 绑定，两步各自可提交。
- 管道字段动态预览可能慢/失败：面板默认折叠管道字段，点开才预览，失败可重试，不阻塞其它产品。
- 槽位映射表若与真实组件类型目录不符（以 `DashboardComponentCatalog` 为准核对），以目录实况修正映射并回填。
- 回滚点：两步两提交，可独立 revert。

## 8. 完成回填（执行后填写）

- 实际改动 / 测试 / 截图 / 偏差 → 总账第 14 节。
