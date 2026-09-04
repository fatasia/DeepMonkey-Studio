# EX-001A 2D 画布选择与操作模型对齐（对标 FVS 第一部分）

> 按模板 `docs/specs/TEMPLATE.md` 编写；执行者：夜间 GLM-5.3-Flash。依据 `docs/editor-interaction-benchmark-2026-09-04.md` §2 EX-001 与 2026-09-04 画布交互盘点。

## 0. 元信息

- 所属批次：EX-001（拆分为 A 选择与操作模型 / B 批量编辑与图层管理）
- 依赖：无
- 预估夜间时段：≤4h
- 触碰域：web 2D 工作区（contracts 不动）

## 1. 目标与用户故事

作为 2D 看板编辑者：Shift 点选能加选；框选碰到即选中（不再要求完全包含）；按住 Alt 拖动组件是复制而非移动；组件被遮挡时右键能列出该位置所有组件并选择。四项合起来即 FVS 的选择与操作心智。

## 2. 现状与复用（2026-09-04 盘盘确认，禁止重复实现）

- 选集语义：`dashboardNodeSelection`（`dashboardWorkspaceModel.ts:381-389`）——additive 仅认 `ctrlKey || metaKey`；单击组员自动全组。
- 节点事件入口：`DashboardCanvasNode.tsx:108/143/191` 传 `additive: event.ctrlKey || event.metaKey`；图层面板 `DashboardWorkspaceLeftPanel.tsx:23` 同。
- 框选：`beginMarqueeSelection`（`dashboardCanvasController.ts:416-466`），命中为**完全包含**（447-451），Ctrl 为加选。
- 拖动事务：`dashboardNodeTransform.ts`（201 行）——`beginNodeDrag` 吸附候选/Alt 绕过（68/80 已占用 Alt 的"绕过吸附"语义，注意区分：**拖动开始时**按住 Alt = 复制拖拽；拖动中途按 Alt = 绕过吸附。FVS 用 option+拖拽即复制；两个语义共存规则见 §4.3）。
- 右键菜单：`openNodeContextMenu`（controller:375-386）只作用于命中顶层节点；`DashboardWorkspaceContextMenu.tsx`（135 行）渲染。
- 复制粘贴克隆：`copySelectedNodes`/`pasteCopiedNodes`（controller:216-244）——structuredClone 整节点、"+ 副本"后缀、偏移 24px、zIndex 顶置、groupId 重生成，可整体复用为"复制拖拽"的克隆来源。
- 快捷键注册：`DashboardWorkspace.tsx` `handleShortcut`（476-560）。
- **红线：`DashboardWorkspace.tsx` 已 799 行，禁止向其新增任何逻辑**；本规格新代码全部进 `dashboardCanvasController.ts`（477 行，上限内有余量）或新文件 `dashboardSelectionTools.ts`（≤200 行）。

## 3. 合同设计

无 contracts 变更。纯交互行为与测试。

## 4. 实现要点

### 4.1 Shift 点选加选

`DashboardCanvasNode.tsx` 三处与 `DashboardWorkspaceLeftPanel.tsx:23` 的 `additive` 判定改为 `event.ctrlKey || event.metaKey || event.shiftKey`。选集 toggle 语义不变（再点同项取消）。

### 4.2 框选改"相交命中"

`dashboardCanvasController.ts:447-451` 的完全包含判定改为矩形相交（node frame 与 marquee 矩形 overlap）。Ctrl/meta 仍为加选。锁定与隐藏节点继续不参与。

### 4.3 Alt+拖拽复制

在移动手柄 `pointerdown` 时读取 `altKey`：

- **按下时**按住 Alt → 立即克隆当前选集（复用 paste 克隆规则，偏移 0），选集切换为克隆体，拖动作用于克隆体；原节点原地不动。整个"克隆+移动"合成**一条撤销记录**（一次 StudioCommand 或紧邻两命令合并策略按 applicationStore 现状选择，若无法合并则在回填记录并接受两次撤销）。
- **拖动中途**按/放 Alt → 维持现有"绕过吸附"语义，不切换复制状态。
- 克隆体命名沿用"副本"后缀规则。

### 4.4 右键选层（遮挡选择）

`openNodeContextMenu` 打开菜单时，用 `document.elementsFromPoint(clientX, clientY)` 收集带 `data-node-id` 的元素（若无该属性则先在 `DashboardCanvasNode` 根元素补上 `data-node-id={node.id}`，artboard 内按 zIndex 从上到下）；菜单顶部新增"选择"子菜单：列出该点下全部节点（名称 + 类型图标，≤10 项，超出折叠"更多"），点击即选中该项并关闭菜单。选中锁定节点时菜单项禁用并提示"已锁定"。

### 4.5 测试与门禁

- 新文件 `apps/web/src/components/dashboardSelectionTools.test.ts`：elementsFromPoint 收集/排序/去重纯函数测试。
- `DashboardWorkspace.test.tsx` 追加：Shift 点选加选/再点取消；框选相交命中（部分越界组件被选中）；Alt+拖拽产生副本且原位保留（按现有测试的事件模拟模式）；右键菜单出现"选择"子菜单并能选中被遮挡节点。
- 门禁：`pnpm --filter @bim-studio/web exec vitest run src/components/DashboardWorkspace.test.tsx src/components/dashboardSelectionTools.test.ts src/components/dashboardNodeTransform.test.ts && pnpm --filter @bim-studio/web typecheck && pnpm quality:source-size`。
- 浏览器证据：dev server + `?__visualQa=dashboard` 截图 3 张（框选相交、Alt 拖拽副本、右键选层菜单），存 `test-output/nightly-<date>/`。无法起浏览器时记录为遗留，不冒充完成。

## 5. 验收标准

- [ ] Shift/Ctrl/Cmd 三键点选均可加选/减选，图层面板一致
- [ ] 框选为相交命中；锁定/隐藏节点不参与；Ctrl 加选不丢
- [ ] Alt 按下拖动 = 复制并拖动副本，原节点不动，可撤销（记录合并与否的实际行为）
- [ ] 右键菜单"选择"子菜单列出遮挡栈并可选中；锁定项禁用
- [ ] 全部新增测试通过；DashboardWorkspace.tsx 行数不增加
- [ ] typecheck + quality:source-size 通过

## 6. 风险与回滚

- elementsFromPoint 在缩放/变换容器下的命中顺序：若顺序与视觉层级不符，回退用 frame 矩形包含该点的节点集合按 zIndex 排序（纯几何法），二选一在回填注明。
- Alt 双语义边界（复制 vs 绕过吸附）若实测体验冲突，保留复制语义优先、绕过吸附改为"拖动中途切换"仍有效；冲突样例记入回填。
- 回滚点：独立提交，revert 不影响他人。

## 7. 完成回填（执行后填写）

- 实际改动文件 / 测试结果 / 截图路径 / 偏差说明 → 总账第 14 节。
