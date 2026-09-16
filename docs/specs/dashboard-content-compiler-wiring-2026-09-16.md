# Dashboard 冻结内容编译接线

编译结果的 `windowEvidence` 提供作者节点与运行节点映射，以及实际使用字体到 atlas 的映射。生成时复核 atlas 像素 SHA-256 与 producer 回执一致；未使用的后备字体不会生成使用证据。API 将其复制给窗口验证器，后者仍须以真实 draw 回执确认覆盖。

服务端 bundle 复用 `compileDashboardRasterContent`、Native cosmic-text 和 sharp，将 C3 冻结内容编译为 canonical runtime v5。没有替代字体、样例数据或客户端资源读取。

## 构建与组合

```powershell
node scripts/build-dashboard-content-compiler.mjs
```

从 `apps/api/dist/dashboard-content-compiler/compiler.mjs` 导入 `createDashboardContentCompiler`，传入实际 Native executable 路径和可信 `configuration`，再将返回对象交给既有 Dashboard runtime 的 `compiler`。配置必须提供 `locale`、`packageVersion`；文字还需要 `nodeAssets[nodeId].textStyle`，同一节点有多个字体时必须提供明确的 `fonts` 顺序。这些配置与生产者 EXE hash 进入 C4 编译器身份，bundle 文件本身提供 compiler SHA。

C4 首次编译和 C5 默认 worker 重编译均传递完整 freeze manifest。资源按 manifest 的 nodeIds、MIME、revision、faceIndex 映射；数据按 manifest 的 nodeId 映射，不把 binding ID 当成节点 ID。映射前检查 manifest、文档、资源和数据 hash；拒绝重复节点数据、多个图片、额外资源和跨节点字体引用。

## 验证

```powershell
node scripts/build-dashboard-content-compiler.mjs
node --test scripts/dashboard-content-compiler.test.mjs
```

设置 `C2_NATIVE_EXECUTABLE` 与 `C2_FONT_PATH` 后，还执行真实 Native 字体光栅化测试；字体仅作本机测试输入，不进入仓库或交付包。图片测试检查 sharp 产出的实际 RGBA；图表测试检查冻结数据 37/91 出现在 ChartIR，而非仅验证对象存在。

## 本轮待办

生产 closure 仍须提供有授权证据的字体/图片、已解析数据，以及可信的继承文字样式和 KPI/表格测量布局。运行时行为与跨宿主外观继续列为 deferred；返回 v5 不代表页面可完整发布。此模块尚未自动注册到 API 启动入口，Dashboard 专用逐对象/字体窗口回执与正式发布下载验收仍需接通。
