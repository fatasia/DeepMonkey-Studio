# 计算字段主题修补 · 2026-09-08

## 已完成

真实浏览器先复现再修改。r39 基线 `computed-fields-theme-s7qAkF` 两轮 dark1440 / light980 共四组；基线模式只记录对比度，不把低对比度计为通过验收。浅色标题 **1.174:1**、空态说明 **3.732:1**；深色空态说明 **3.999:1**。浅色字段卡片仍整块暗色，导致主题割裂；原错误文字在暗色卡片上可读，不误报为错误文字不可见。

根因是 `platform-pages.css` 的 `.data-computed-field*` 作用域残留硬编码，后加载 `data-center-workbench.css` 只覆盖部分字号/标签，未覆盖标题和卡片底色。本批只将该作用域标题、说明、卡片、分隔线、添加/删除按钮、错误状态改用 `base.css` 既有令牌，hover 仅作用于可用按钮；未修改行业预览、打印或运行页样式。

- `computedFieldsTheme.test.ts` + `DatasetWritebackConfigFields.test.tsx`：2 文件 7 项通过。
- `node --check apps/web/scripts/gate-computed-fields-theme.mjs` 通过。
- 新门禁检查：真实数据中心新建计算字段、键盘添加/删除、错误禁保存、保存/刷新配置保持；每组保留空态/错误/已填写截图，定量检测标题、说明、按钮、字段标题、标签、依赖及错误文字。
- 对标依据：工作区西门子克制工业表单与帆软数据工作流要求，遵守 `design-taste-digitaltwin`；不声称达到完整外部产品能力。

### r41 最终浏览器复验

`node apps/web/scripts/gate-computed-fields-theme.mjs` 退出 0，非基线门禁 **4/4** 通过，四组无页面异常和控制台错误/警告。产物 `test-output/codex-2026-09-05/computed-fields-theme-4beYf2/report.json`，Web index SHA256：`cf78e0ced7ea4494d170fea1ecf4368a5f7c190bbad78b2d7e9cb1f88e397353`。构建日志 `.runtime-logs/codex-20260908-web-build-r41.log`；本子任务未修改 dist。

| 正文对比度 | 深色两轮 | 浅色两轮 |
|---|---:|---:|
| 计算字段标题 / 添加按钮 | 13.736 | 14.454 |
| 标题说明 / 空态 | 5.530 | 4.559 |
| 字段标题 | 14.915 | 15.865 |
| 字段标签 / 依赖说明 | 6.005 | 5.004 |
| 错误文字 | 5.932 | 5.937 |

8 个文本采样点每组均 ≥4.5:1；两轮共 12 张截图，已亲审 `r1-dark/light-empty`、`r1-dark/light-invalid`、`r2-dark/light-empty`、`r2-dark/light-field` 八张。浅色卡片已回归浅色表面，错误状态、输入焦点及文字可辨；添加→填值→空 Key 禁保存→恢复→再次添加→键盘删除→保存→刷新后服务端字段保持均实际断言。

### 十维自评

| 维度 | 分数 / 10 | 证据及不足 |
|---|---:|---|
| 布局构图 | 9 | 两主题分组一致，无新增遮挡 |
| 令牌一致性 | 9 | 计算字段作用域已无硬编码颜色；范围外旧色另列待办 |
| 排版 | 8 | 正文对比已达标；既有类型栏仍截断 Number，字段标题偏小 |
| 交互状态 | 9 | 空态、输入、错误、禁保存、键盘添加删除、保存恢复通过 |
| 动效质量 | 不适用 | 未新增动效 |
| 3D 渲染质量 | 不适用 | 非 3D 任务 |
| 信息设计 | 8.5 | 分组明确；既有安全机制说明较长，未擅自改文案 |
| 反馈即时性 | 9 | 错误和依赖随修改更新，保存恢复真实断言 |
| 响应式与主题 | 9 | 本批 dark1440/light980 两轮通过，更小断点未扩大承诺 |
| 语义与文案 | 8 | 中文页既有 Key/Number 等混用保留，待整体交互收尾 |

颜色修补已验收，仍有低于 9 分的既有排版/文案，故不宣称完整 Kimi-95 或全站视觉完成。

## 本轮待办

同族检查还发现作用域外的 `.data-form-heading strong`、`.data-preview-empty strong` 浅色可读性不足，r41 仍存在；已通知主线程，本次不扩改。计算字段类型列固定 82px，既有 Number 文本截断，文案 Key/Number 等中英混用也保留为整体收尾项。完整键盘路径、更小断点和全站视觉收尾仍按总账执行。

### 2D 填报入口只读核对

现有 REST 服务、`DatasetWritebackPanel`、session、草稿缓存和权限可复用；2D 数据来源已可绑定 `datasetId`。但 `contracts/dashboard.ts` 没有业务表单组件类型，`DashboardWidgetRuntime.tsx` 的 input 只是筛选，不能写业务行。

最小接线建议是**先做作者检查器入口**：绑定已启用 writeback 数据集后显示“填报”，在独立面板复用 `DatasetWritebackPanel`；显式传 userId/canWrite，换对象/关闭仍保护草稿。

- 新 `DashboardDatasetWriteback.tsx`：数据集选择结果与现有面板适配。
- `DashboardInspectorData.tsx`：入口；复用 `DashboardDataSource` 的已绑定数据集，不新增临时 URL。
- `dashboardWorkspaceTypes.ts` / 工作区 context：身份与权限合同。
- `views/AppPlatformRoutes.tsx`：现有 currentUser 显式下传给 DashboardWorkspace。
- 聚焦及真实门禁：2D 绑定→填报→实际读回→关闭返回画布、跨对象/项目保稿、viewer 禁写。

这只能称为 2D 作者工作流接入；若需要可发布画布内表单，还缺组件合同、目录默认配置、记录定位、运行身份/权限与画布缩放交互。不能把检查器入口或现有 filter 称为完整表单设计器。

## 明确排除

未改账号、`.env`、正常数据或存储拓扑，不 push，不自行构建/修改 dist。本批不实现 2D 扩域、不恢复匿名写回、统一语义或协作。

## 项目级后验收

真实复杂表单与窄屏完整体验、全站主题一致性和完整十维视觉门槛仍需统一验收。当前限计算字段颜色及既有增删改/保存链路，不代表全部数据中心工作流已验收。
