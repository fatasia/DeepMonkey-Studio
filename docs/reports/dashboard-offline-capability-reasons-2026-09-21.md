# Dashboard 离线包能力原因链

2026-09-21。本片审计并补齐 Dashboard 离线候选的对象级原因透传。目标是让作者端看到编译器给出的真实降级/阻断原因，同时保持已有 v1 capability 报告和旧候选可读取。

## 现状与根因

Web Dashboard 编译器的对象报告已经包含 `reasons`。`rasterNode` 和 `compileDashboardContent` 会记录媒体解码器、冻结字体、数据绑定、图表外观、三维编译等具体原因。原生产桥 `scripts/dashboard-content-compiler.mjs` 返回 API 时只保留 `contentCompiled` 和 `deferredFields`，因此服务端 `DashboardPublicationCapabilityReport`、候选 HTTP metadata 和 Web 对话框只能展示“字段未编译”。

## 本轮改动

- `AuthoritativeDashboardCompiler` 的对象结果增加可选 `reasons?: readonly string[]`。
- capability report v1 的对象项增加同名可选字段；服务端复制、去空白并去重，不改变 `supported/degraded/blocked` 判定。
- 编译器桥把对象原因带入 C4 结果。遗漏的 authored object 继续 `blocked`，并记录明确的“编译器未返回对象报告”原因。
- 候选创建接口将原因随对象摘要返回；旧响应没有该字段时仍按原有 `deferredFields` 解析。
- 离线包对话框优先展示真实原因，同时保留字段清单作为补充和旧合同回退。

`schemaVersion` 保持为 `1`。原因字段是加法字段，旧 capability JSON、旧候选响应和仅提供 `deferredFields` 的测试/部署编译器仍有效。发布 gate 仍以对象状态与 `deferredFields` 自洽为准，没有因为显示原因而放宽或收紧打包条件。

## 验证

- `pnpm --filter @bim-studio/api exec vitest run src/dashboardPublicationCapability.test.ts src/dashboardPublicationCandidateRoutes.test.ts`
- `pnpm --filter @bim-studio/web exec vitest run src/components/DashboardOfflinePackageEntry.test.tsx src/components/dashboardOfflinePackageState.test.ts`
- `pnpm --filter @bim-studio/api typecheck`
- `pnpm --filter @bim-studio/web typecheck`

本片没有执行浏览器视觉验收、真实 EXE 窗口验收或完整下载链；这些证据仍按 Dashboard 发布总验收门槛单独记录。
