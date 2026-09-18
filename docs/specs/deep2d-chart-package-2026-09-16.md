# 动态 ChartIR 入包(P0-02)

日期:2026-09-16 凌晨。接手自 [Deep-Engine-Deep2D 统一交接](C:/Users/rain/AppData/Local/Temp/Deep-Engine-Deep2D-handoff-2026-09-16-0045.md) 推荐的第一开发切片。

## 合同

运行包 schema 新增 v4(chart 时代),常量 `DEEP_RUNTIME_PACKAGE_CHART_VERSION=4`,双侧(TS `packages/deep-engine/src/runtimePackage/`、Rust `packages/deep-engine-native/src/runtime_package/`)同规则:

- 新资源种类 `chart-runtime`、`chart-sim-runtime`;入口键 `chart`(必填非空)、`chartSim`(可空)。v4 起两个键必须显式声明;v1–v3 出现即拒绝。camera 在 v4 变为可选(v3 仍必填),因此纯二维 chart 包不再被三维相机合同绑架。
- 载荷信封:`{schema:"deep-engine.chart-runtime",schemaVersion:1,id,revision,chart:<ChartIR>}` 与 `{schema:"deep-engine.chart-sim-runtime",schemaVersion:1,id,revision,fixture:<ChartSimFixture>}`。信封 id/revision 与资源索引逐一绑定;内层 ChartIR 走 `parse_chart_ir`/`validateChartIR` 既有严格校验,sim fixture 走 `parse_chart_sim_fixture` 并强制 `chartId` 指向同包 chart。
- `chart` 与 `deep2d` 入口互斥(图表展示列表替代静态二维内容);`chartSim` 必须伴随 `chart`。这些在包校验层拒绝,不靠运行时兜底。
- v4 沿用 v2 的 materialBindings 必填合同(可为空数组);TS builder 的 `normalizeRuntimeMaterialBindings` allowEmpty 按 `hasChart||hasCamera` 放行,与 Native `schema_version >= CAMERA_VERSION` 对齐。
- `buildChartRuntimePackage({packageId,packageVersion,chart,chartSim?})` 生成空三维场景包,packet id 由 `packageId+chart.id` 内容寻址派生,与 dashboard 包同构。

## 运行时接通

`PlayerContent::from_package` 不再将 chart/chart_sim 置空:图表装配提取为 `player_content_chart_entry.rs`,重建 `ChartRuntime`(640×360,与独立 CLI 同管线的窗口内 letterbox/resize 机制不变)、经 `present_chart` 生成展示列表、用包内 fixture 构造 `ChartSimHost`。换包销毁宿主、present 后提交 LKG 恢复检查点、视图重载语义均复用既有合同,无第二套 loader。CLI 零新增:`--package/--headless-package/--smoke-package/--package-recover` 经 `from_package` 自动支持图表包。

## 跨端 golden

`packages/deep-engine/scripts/generateChartRuntimeGolden.mjs` 在独立 test-output 临时 bundle 调真实 TS 构建器,产出 `fixtures/chart-runtime-v1.json`(带 sim,包哈希 `99e0beb90741a5bc420def46e5620e71697f61f3238d4550a64d7b1641fc3f1b`)与 `fixtures/chart-runtime-static-v1.json`(无 sim,`82fdf617427beb38f1f062fc21043beb327390b73fa359647487c0e1601c5fed`),均基于既有冻结夹具 `chart-ir-v1.json`/`chart-sim-v1.json`。TS 测试逐字段重建对照;Rust `tests/chart_runtime_golden.rs` 读取同一份包。

## 验证证据(2026-09-16 01:00–01:30)

- deep-engine vitest 341 文件/2821 通过(含新增 `chart.test.ts` 3 项:双夹具逐字段、revision 稳定与输入隔离、v4 入口合同含互斥组合拒绝);tsc 双配置通过。
- Native 全套 697 通过/0 失败/52 显式 GPU 忽略;bin 87 通过(含新增 from_package 2 项);golden 集成 5 项通过;`--all-targets` 0 warning。
- 真实 GPU 窗口(RTX 4060 Laptop/Vulkan,固定 EXE SHA `60343016d777691c162f0a85bc1e88224befa5a2f65e7cbf31b526fc62cbf2e2`):
  - sim 包 `--smoke-package`:包哈希命中、11 commands/101 segments 呈现、`3 fixed-clock data commits presented; cancellation clean`、present 后 recovery checkpoint 提交,scopes/callbacks clean;
  - 静态包 `--smoke-package`:数据追加+缩放提交、两次选中像素提交、`initial/zoom/reset/tooltip/clear GPU frames presented`、恢复检查点提交,scopes/callbacks clean。
- 工作区门禁:`pnpm gate:repository` 通过;`pnpm quality:source-size` 4311 文件通过(800 行上限)。

## 边界与并行会话残留

- deep-engine 包级 300 行门禁与 runtime purity 门禁当前失败,全部命中并行会话的未跟踪/在途文件(`browserImageDecoder.ts` OffscreenCanvas、`chart_render.rs` 748 行等 13 项);本切片文件全部达标(`player_content.rs` 291 行,图表装配与 bin 测试已按职责拆出)。归他们会话收口,本切片不代改。
- 浏览器下载落盘、Dashboard 组件 lowering、正式发布证据等其余 P0 项不变,仍按任务表推进。
- 本切片未 commit;共享脏工作树遵守交接纪律,仅逐文件审查后由用户决策提交节奏。
