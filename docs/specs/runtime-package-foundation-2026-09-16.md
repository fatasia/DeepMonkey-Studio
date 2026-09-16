# Runtime Package 基础合同提交

本切片为 Dashboard 组合包补齐 TypeScript 提交基线：相机 v3、单图表 v4、静态二维封包，以及 ChartIR 读取、数据更新和固定步仿真。Native 已有对应消费方。

保留 v1/v2 及旧 golden。v4 仍限制单图表与静态二维入口互斥；多图表由后续 C1 v5 表达。本切片没有正式 Dashboard 发布、HDR、LOD、形变或 prewarm 扩展。

验证基于 `8e431b2` 独立导出，仅叠加本切片 23 个文件：Runtime Package 与图表数据相关 12 文件、219 测试通过，核心和 Lab 类型检查通过。仓库治理门禁通过。隔离源码与工作树之间的范围差异仅保留在本地 `test-output/runtime-v34-head-audit/`，原始日志不提交。

下一步按 [C1～C5](codex-dashboard-delivery-slices-2026-09-16.md) 推进。跨端像素、完整内容、资源冻结与正式离线交付仍须各自验收。
