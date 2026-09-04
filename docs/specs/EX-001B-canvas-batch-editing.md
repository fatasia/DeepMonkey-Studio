# EX-001B 2D 批量编辑与图层管理（对标 FVS 第二部分）

> 按模板 `docs/specs/TEMPLATE.md` 编写；执行者：夜间 GLM-5.3-Flash 或白天模型。依据 `docs/editor-interaction-benchmark-2026-09-04.md` §2 与 2026-09-04 画布交互盘点。

## 0. 元信息

- 所属批次：EX-001（B 部分；A 部分 EX-001A 先行，无相互依赖）
- 依赖：无（可与 EX-001A 同夜或异夜执行）
- 预估夜间时段：≤4h
- 触碰域：web 2D 工作区 + packages/studio-core

## 1. 目标与用户故事

作为 2D 编辑者：图层行右键有批量菜单（复制/粘贴/隐藏/锁定/调整层级）；多选组件时右侧可以直接批量改位置尺寸（不用逐个改）；对齐可以"对齐到页面"；选中编组组件时画布显示整个组的边界框。对标 FVS 的图层右键批量、组合页签、对齐入口。

## 2. 现状与复用（盘点确认）

- 图层列表：`DashboardWorkspaceLeftPanel.tsx:9-50`（`DashboardLayerList`，行内仅选择/显隐/锁定/删除四按钮，无右键菜单）。
- 多选检查器：`DashboardWorkspace.tsx:231` `selectedNode`=第一个命中节点；`DashboardInspectorContent.tsx:46-67` X/Y/W/H 只编辑该单节点；`DashboardInspectorBulkData.tsx`（50 行）已有批量换源块模式可参照；`DashboardInspectorSelection.tsx:77-85` 有"删除未锁定所选"。
- 对齐：`studio-core/src/dashboardLayout.ts` `alignDashboardFrames`/`distributeDashboardFrames` 只按选区包围盒；入口 `DashboardWorkspaceCanvas.tsx:167-204`。
- 编组：平铺 `groupId` 模型（contracts `application.ts:44-45`）；单击组员自动全组（`dashboardWorkspaceModel.ts:384-386`）；无组边界框渲染。
- 右键菜单 UI：`DashboardWorkspaceContextMenu.tsx`（135 行）可扩展复用其样式。
- 层级操作：`reorderNodeIds`（controller:336-355）；批量锁定/隐藏：`updateContextNodes`（controller:399-402）；复制粘贴：`copySelectedNodes`/`pasteCopiedNodes`（controller:216-244）。
- **红线：`DashboardWorkspace.tsx` 799 行禁止增行；`DashboardInspectorData.tsx` 760 行同。**新组件放新文件。

## 3. 合同设计

无 contracts 变更（groupId 平铺模型保持；组边界框为纯派生渲染）。

## 4. 实现要点

### 4.1 图层行右键批量菜单

`DashboardLayerList` 行加 `onContextMenu`：多选感知的菜单（选中数显示在 header）：
- 复制（=copySelectedNodes）/ 粘贴（=pasteCopiedNodes，仅当剪贴板非空）
- 隐藏/显示、锁定/解锁（对全部选中行）
- 置顶/置底/上移/下移（=reorderNodeIds，多选时按原有相对顺序整体移动）
- 删除（未锁定的选中行）
菜单组件新文件 `DashboardLayerContextMenu.tsx`（≤120 行），样式复用 `DashboardWorkspaceContextMenu.css` 既有类。锁定行右键时除"解锁"外全部禁用。

### 4.2 多选批量位置/尺寸编辑

`DashboardInspectorContent.tsx` 改为按选区分支：
- 单选：现状不变（X/Y/W/H 精确编辑）。
- 多选（≥2 且非全部锁定）：显示"批量编辑"块——X/Y（把所有选中节点左上角对齐到该值，即统一设置）、W/H（等比缩放：以选区包围盒为基准，按比例应用到各节点，保持相对位置与间距比例）。沿用现有数字输入组件样式；输入应用为一条撤销命令（Frame 批量更新已有命令模式，核对 `dashboardContentController` 的 updateFrames 类命令）。
- 多选摘要行：`已选 N 项（含 M 组）`，与删除按钮并存。
- `DashboardInspectorSelection.tsx` 编排不动，只把内容块分支放 `DashboardInspectorContent.tsx` 或新文件 `DashboardInspectorBatchFrame.tsx`（≤150 行）——若 InspectorContent 行数吃紧则拆新文件。

### 4.3 对齐到页面

`studio-core/src/dashboardLayout.ts` 增加 `alignFramesToArtboard(frames, artboardSize, mode)`：选区整体相对页面（artboard）左/右/上/下/水平居中/垂直居中，保持选区内部相对布局。工具栏对齐按钮组旁新增"页面"开关（toggle）：开启时对齐按钮作用于页面而非选区包围盒（分布按钮不参与，保持禁用态不变）。命令仍走现有 layout 命令通道（可撤销）。

### 4.4 组边界框可视化

`DashboardWorkspaceCanvas.tsx` 节点列表渲染后，对当前选中节点所属组计算成员包围框（client 坐标换算复用画布 transform），绘制一个虚线描边 div（类名 `dashboard-group-outline`，样式进 `dashboard-workspace.css`，双主题变量描边色），并显示组名标签（`groupName`）。组 outline 不响应事件（pointer-events:none）。编组即全选的现状不变。

### 4.5 测试

- `DashboardWorkspace.test.tsx` 追加：图层右键菜单渲染与动作（隐藏/锁定/置顶）；多选批量 X 设置后全部节点左对齐到该值；W 批量为等比缩放（断言两节点宽度比例不变）；"页面"开关下居中对齐相对 artboard；选中组员出现组 outline 且含组名。
- `packages/studio-core/src/dashboardLayout.test.ts` 追加 `alignFramesToArtboard` 六向用例（含负坐标/越界钳制沿现有行为）。
- 门禁：`pnpm --filter @bim-studio/web exec vitest run src/components/DashboardWorkspace.test.tsx && pnpm --filter @bim-studio/studio-core test && pnpm --filter @bim-studio/web typecheck && pnpm quality:source-size`。
- 浏览器：dev server `?__visualQa=dashboard` 截图（图层右键菜单、批量编辑块、组 outline、页面居中对齐前后），双主题。

## 5. 验收标准

- [ ] 图层行右键菜单七项动作全部可用且多选生效；锁定行权限正确
- [ ] 多选批量 X/Y 为统一对齐语义、W/H 为等比缩放语义，单条撤销
- [ ] "页面"开关切换对齐基准，六向对齐可撤销；分布不受开关影响
- [ ] 组 outline 显示组名、不拦截事件、深浅两主题描边可见
- [ ] 全部测试通过；红线文件行数不增加；新文件 ≤150/120 行
- [ ] typecheck + quality:source-size 通过

## 6. 风险与回滚

- 批量 W/H 等比语义若与现有多选 resize 手柄行为不一致，以"输入框=等比、手柄=现状"为准并在回填注明。
- `DashboardInspectorContent.tsx` 若超 500 行则必须拆 `DashboardInspectorBatchFrame.tsx` 再实现。
- 回滚点：独立提交。

## 7. 完成回填（执行后填写）

- 实际改动文件 / 测试结果 / 截图路径 / 偏差 → 总账第 14 节。
