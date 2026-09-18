# 独立二维运行包入口

`buildDashboardRuntimePackage` 接收已经编译的 Deep2dRuntimePackage，复用现有 buildDeepRuntimePackage 生成真实可序列化容器；入口从 `@bim-studio/deep-engine/runtime-package` 导出。

二维画面使用既有路径、atlas、quad，场景入口为空几何/材质/实例/贴图，不插入占位模型。场景资源 ID 按 packageId 和 deep2d.id 派生，revision 跟随二维内容；输入经既有 builder 深拷贝、资源和包 SHA256、schema 验证。坏像素长度直接拒绝。

验证：两项专项覆盖真实atlas夹具、序列化再解析、输入隔离、revision与稳定ID、坏像素拒绝与后续恢复；deep-engine tsc 和 repository gate 通过。本批未重建共享dist。

本轮待办：这是已编译内容的包装入口。DashboardDocument 到组件内容的 lowering、动态 ChartIR 入包、对象能力报告、source/compile/target 三种 hash 绑定、发布动作接线与Native读取该入口生成包的跨端golden仍需完成。既有 compileDashboardLayout 仅处理外框，不能传入它并声称组件内容已编译。尚无此入口的正式发布或窗口验收证据。

## 跨语言包与窗口冒烟

后续已补 `fixtures/dashboard-runtime-v1.json`：由 `scripts/generateDashboardRuntimeGolden.mjs` 调用真实TS构建器生成，不手工拼装包。脚本在test-output内临时bundle源代码，不占用共享dist；修改golden前要审查预期变化。TS测试逐字段重建对照，Rust测试读取同一份包，准备真实atlas像素，篡改像素而未更新hash时拒绝。

复现：在deep-engine目录执行 `node scripts/generateDashboardRuntimeGolden.mjs`；根目录执行 `cargo test --manifest-path packages/deep-engine-native/Cargo.toml --test dashboard_runtime_golden` 和 `cargo run --manifest-path packages/deep-engine-native/Cargo.toml -- --smoke-package packages/deep-engine/fixtures/dashboard-runtime-v1.json`。

包hash：`8e2f1292db93a43d7b15f63f4933a6c60f29dee6560212c51ccd31ac96f417c6`。TS2/Rust2通过；RTX4060 Laptop Vulkan真实64x64窗口呈现路径1、atlas2、glyph quad2、image quad1，GPU scopes/callbacks clean，present后恢复检查点提交。该证据替代上文“缺少入口跨端golden”的状态；组件lowering、动态语义、正式发布和完整双轮视觉仍未验收。
