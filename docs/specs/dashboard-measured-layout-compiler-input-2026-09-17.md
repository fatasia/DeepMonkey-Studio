# G04 切片 A：可信布局测量接入编译输入（2026-09-17）

对应 [Dashboard 可信 Chromium 布局宿主](dashboard-trusted-layout-host-2026-09-16.md)的"明确未完成"第一条：
宿主测量接入 API 启动的正式候选准备链路。

## 改动

`apps/api/src/dashboardRuntimeArtifactCompiler.ts`：

- `PrepareDashboardRuntimeArtifactCompilerOptions` 新增可选 `layoutCapture: { host, locale }`。
- 提供宿主时，`prepareDashboardRuntimeArtifactCompilerInput` 对文档中每个**可见、类型在测量合同内**（value/table/bar/line/scatter/pie）、**有冻结数据**的数据组件：
  1. `captureDashboardMeasuredLayout` 在服务端可信宿主测量（宿主只回测量值，`freezeManifestSha256`/`dataSha256`/字体 hash 均由冻结候选计算）；
  2. 在编译输入边界 `verifyDashboardMeasuredLayout` 复核绑定；
  3. 把 `layout`（及表格 `table` 状态）合并进该 dataId 的冻结数据值。
- 缺省不提供宿主时输入与既有行为逐字节一致（纯冻结数据）；已带 `layout` 的冻结值直接拒绝（防上游重复装配被静默覆盖）；字体缺失、绑定过期、取消均使整个候选准备失败（fail-closed）。
- 无冻结数据的可测量组件保持不动，由光栅编译器既有的数据不可用降级路径处理，不冒充已测量。

## 测试

`dashboardRuntimeArtifactCompiler.test.ts` 3→6 项，新增：

1. 注入宿主后 value 组件的编译输入 data 绑定服务端测量布局，宿主恰好被调用一次；
2. 无冻结数据/不可见组件不触发捕获（`input.data` 保持原样）；宿主返回未绑定字体引用时按 `DashboardLayoutFontMissingError` 语义拒绝；
3. 冻结数据自带 `layout` 时拒绝覆盖。

`pnpm --filter @bim-studio/api typecheck` 通过；该文件与 `dashboardMeasuredLayout`、`dashboardNativeCandidateService` 聚焦 28 项通过；API 全量 1178 通过 / 1 跳过（同基线）。

## 明确未完成（不标成完成）

- **切片 B（部署适配）**：API 进程内嵌的正式 Chromium 宿主（进程管理、字体注入、超时与崩溃隔离）尚未建设；当前生产入口接受注入宿主，但部署侧尚无宿主可注。
- 测量布局的下游消费（部署 compiler bundle 对 `DashboardFrozenData.layout` 的光栅编译）由既有 web 光栅链承担，本片未改变编译器 worker。
- css-binding 模式测量回退字体几何的既有边界不变。

## 下一步

1. G04 切片 B：正式 Chromium 宿主服务（复用 `scripts/verify-dashboard-trusted-layout-host.mts` 已验证的捕获页与注入协议）。
2. P0-04：能力报告落正式发布 manifest 并接放行消费方（依赖本片候选链输入完整性）。
