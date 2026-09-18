# DashboardDocument v1 编译源

## 已完成

`packages/contracts/src/dashboardDocument.ts` 定义发布编译源封装，复用已有 `ApplicationDocument v2`，不新增一套页面/组件存储格式。

| 字段 | 契约 |
| --- | --- |
| schema | `deep-engine.dashboard-document` |
| schemaVersion | `1` |
| entryPageId | 必须引用 application.pages 中存在的页面 |
| application | 完整 `ApplicationDocument v2` 快照 |

身份和源 revision 取 `application.metadata.id/revision`，不复制第二套可分歧的版本字段。页面、数据绑定、交互、脚本及依赖、三维场景、资源、时间轴、发布配置和空间导航完整保留；未知能力由后续编译器及能力报告处理，不能靠丢字段把结果变成支持。

`createDashboardDocument` 复制调用方应用文档并执行校验；`assertDashboardDocument` 复用已有应用校验，再要求 envelope 版本/字段、入口引用及唯一页面/节点身份。节点 ID 在完整文档范围唯一，因为现有 widget 引用不包含页面限定符，重复 ID 会造成跨页对象解析歧义。

文档内部显式引用校验已接入：视口的 sceneId/cameraViewId、交互来源的 page/widget/scene/object、发布配置入口、空间导航的显式场景和页面必须存在。场景、场景对象、相机视图身份不能重复。外部资产、模型内部 layerId、脚本命令及动作目标仍需后续依赖解析，不能把本检查扩大为全部引用已验证。

这是编译源，不是 Native 可执行 payload。脚本源和连接引用不能原样进入纯 Native 运行包，后续需分别 lowering、外置和记录能力状态。

`apps/web/src/delivery/compileDashboardLayout.ts` 已将选定页面的外框转换为现有 `RetainedUiTree v1`：页面尺寸、节点 frame/zIndex/visible、数组顺序及稳定身份。布局 ID 由应用/页面/对象身份的 SHA-256 派生，移动对象不会改 ID；暂用应用 revision 标记树和节点。结果保留完整源及逐节点未消费字段，不创建假的图表/文本内容。外框节点不承担绘制或命中语义。

共享 `dashboard-layout-source-v1.json` 由真实编译器生成 `dashboard-layout-v1.json`，TS 重编译比对树及全部矩形，Native 读取同一树并比对位置、尺寸、层级和顺序。此夹具含三个可见布局节点；Native 会裁掉不可见布局节点，TS 求解器则保留矩形给后续过滤，两者的不可见节点列表不能直接视为相同。

## 本轮待办

发布流程从已保存或已发布的权威应用快照创建此源。建立 source/compile/target 身份和对象能力映射，把外框布局与文本、图表、数据、行为转换为完整运行资源；未消费字段显式报告。外框 pass 尚未接入正式发布和运行包构建，不能称 DashboardDocument 已完成跨端发布。

应用级剩余引用验证、对象 revision/依赖图、Native 对应读取与跨端 golden、视觉/行为证明仍需补齐。现有 ApplicationDocument 的未知字段策略保持原样，本封装不宣称其所有扩展已被深度校验。

## 验证

源复制不受后续页面/脚本/metadata 修改影响，JSON 往返保留完整内容；入口丢失、重复页面/节点、未知 envelope 字段和错误作者 schema 被拒绝。源封装 4 项、内部引用 7 项与既有应用验证 95 项通过；contracts 类型检查及仓库门禁通过。

外框编译 5 项通过：源隔离、未消费内容、稳定身份、同层顺序、范围拒绝和真实 golden 重编译；Native 可见外框对照 1 项通过。Web 类型检查通过。文字、图表、视觉样式、viewportFit、命中和可访问性消费未在此验证。
