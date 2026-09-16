# Dashboard 可信 Chromium 布局宿主与冻结布局绑定

日期:2026-09-16。对应接手清单「接通可信 Chromium layout host 与 C3 冻结数据/布局 hash,验证取消、字体缺失、字体 hash 变更和重复捕获」。

## 信任边界

布局测量必须来自**服务端自己的 Chromium**,而不是发布请求的浏览器客户端。合同层
(`apps/api/src/dashboardMeasuredLayout.ts`)按既有 worker 边界模式切分信任:

- 宿主(`DashboardLayoutCaptureHost`)只回传**测量值**(`layout` + 表格分页/排序状态);
- 记录的全部身份字段——`freezeManifestSha256`、`documentSha256`、`dataSha256`、
  字体 `sha256/faceIndex` 列表——由 `captureDashboardMeasuredLayout` **从冻结候选计算**,
  宿主在结构上无法伪造绑定;
- `layoutSha256` 用冻结域唯一的 canonical JSON SHA-256
  (`dashboardCanonicalJsonSha256`,非有限数直接拒绝)覆盖 `logicalSize + layout + table`,
  任何篡改在 `verifyDashboardMeasuredLayout` 复核时暴露。

## 合同要点

- `dataId` 复用生产闭包的 `dashboardDataRequestId(nodeId)`(同一推导,双处共享)。
- 只接受 `value`/`table` 两类 widget;隐藏节点、无字体绑定的节点、frame 越界拒绝测量。
- 捕获输出中每个文本框的 `fonts` 引用必须是该节点冻结字体集合的子集,越界引用抛
  `DashboardLayoutFontMissingError`(捕获端 fallback 家族即在此 fail-closed)。
- 布局形状全量校验:角色枚举、矩形四元组有限非负、文本度量、按钮组、绘制顺序索引。
- `verifyDashboardMeasuredLayout(record, candidate)` 可在编译输入组装、能力报告、下载等
  任意后续边界复核:manifest 伞检查(现实的字体/数据变更都会产生新 manifest)→ 数据
  canonical hash → 节点字体集合逐 hash 比对,分级报告 stale 原因,不合并成布尔。

## 真实 Chromium 宿主验证

`scripts/verify-dashboard-trusted-layout-host.mts`(`pnpm exec tsx` 运行):

1. esbuild 打包参数化捕获页(`apps/web/scripts/fixtures/dashboardTrustedLayoutCapture.tsx`,
   请求由 `addInitScript` 注入,页面不自定身份),服务端构建冻结候选;
2. playwright 逐捕获新建隔离页面,`captureRenderedDashboardData` 测量生产挂载组件;
3. 场景:A 绑定+复核;B 重复捕获 hash 一致;C 预中止 + 在途中止(真实页面被关闭);
   D 字体缺失。
4. 证据写 `test-output/dashboard-trusted-layout-host/result.json`(不入库)。

字体注入两种模式:

- `DASHBOARD_TRUSTED_LAYOUT_FONT=<file>`:fontface 注入模式,冻结字节经 `FontFace`
  注入页面。**Chromium 对 ArrayBuffer FontFace 懒解析**,故 fixture 用实测排版宽度探针
  (注入族 vs 回退族)验证字节真实生效,无效字节按缺字体拒绝;
- 未设置时:css-binding 模式,沿用既有 DOM 捕获夹具约定(`resolveFonts` 直接返回冻结
  资源 id),字体缺失场景以未绑定引用注入验证。仅本机测试证据,不进入交付物。

## 验证结果(2026-09-16,本机 Chrome headless)

- 双模式通过:绑定复核、重复捕获 `layoutSha256` 一致、取消(预中止/在途中止)、
  字体缺失(未绑定引用 / 无效字节)四项全部按预期拒绝;
- 合同单测 13 项(含取消三态、字体 hash 变更、数据变更、篡改布局/绑定、非法形状);
- `pnpm --filter @bim-studio/api test`:**1135 通过 / 1 跳过**;typecheck 通过。

## 明确未完成(不可标成完成)

- 宿主尚未接入 API 启动的正式候选准备链路(部署适配把 record 组装进编译输入
  `DashboardFrozenData.layout` 的接线留待 G04/G05 切片);
- css-binding 模式测量的是回退字体几何,不声明与交付字体逐像素等价;
- 字体目录的机器级部署与许可治理仍按
  [Dashboard Native 启动说明](dashboard-native-startup-2026-09-16.md)的边界执行。
