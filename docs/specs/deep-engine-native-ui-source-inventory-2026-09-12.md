# Deep Engine 原生 UI 源码盘点（2026-09-12）

## 1. 目的

这份盘点回答一个有限问题：当前 Studio 源码中，哪些文件存在 React、DOM/CSS、ECharts、Monaco、Worker、网络以及 Three/原始图形 API 的静态耦合候选。

它为后续 `UiState`、`ChartSpec`、`OverlayCommand` 和 `HostCapabilities` 的边界设计提供基线，不是原生迁移工期、运行时覆盖率或兼容性证明。

权威机器可读结果：[`deep-engine-native-ui-source-inventory-2026-09-12.json`](./deep-engine-native-ui-source-inventory-2026-09-12.json)

## 2. 可复现方法

执行：

```powershell
node packages/deep-engine/scripts/collectNativeUiInventory.mjs
node --test packages/deep-engine/scripts/collectNativeUiInventory.test.mjs
```

扫描器只读取：

- `apps/web/src`；
- `apps/web/package.json` 中直接声明为 `workspace:*` 的 `@bim-studio/*` 依赖包的 `src`；
- TypeScript、JavaScript、JSX/TSX、CSS 和 SCSS 源码。

生成目录、依赖树、资源和运行产物不进入语料。测试文件与声明文件会进入语料，JSON 中保留全部源文件 SHA-256、字节数、总语料 SHA-256、逐文件分类证据和解析诊断。

本次语料：

- 文件数：1,724；
- 字节数：10,012,498；
- 语料 SHA-256：`dc5dbff8ac9d5375db8a6be418ce4502fd9ccc3155b0a74d324c0e8e881566aa`；
- TypeScript/JavaScript 解析诊断：0。

## 3. 静态候选结果

| 分类 | 命中文件 | 证据次数 | 代表文件 |
|---|---:|---:|---|
| React 逻辑 | 549 | 17,224 | `DashboardComponentPreview.tsx`、`TopologyEditorPanelView.tsx`、`DataCenterForms.tsx` |
| DOM/CSS/浏览器 API | 470 | 1,273 | `AppBehaviorOverlay.tsx`、`useAppRuntimeEffects.ts`、`dashboardCanvasController.ts` |
| ECharts import/option/runtime | 15 | 108 | `DashboardWidgetVisualization.tsx`、`dashboardAdvancedChartOptions.ts`、`dashboardReadableChartOptions.ts` |
| Monaco | 6 | 60 | `professionalCodeIntelligence.ts`、`professionalCodeServices.ts`、`ProfessionalCodeEditor.tsx` |
| Worker | 14 | 42 | `SceneBehaviorHost.ts`、`modelOptimizer.worker.ts`、`viewerOffscreenController.ts` |
| 直接网络 API | 9 | 12 | `api.ts`、`sceneDataSocket.ts`、`rosbridgeSocket.ts` |
| Three/原始图形 API 逃逸 | 152 | 258 | `postProcessingRuntime.ts`、`webGpuPostProcessingRuntime.ts`、`sharedGltfAssets.ts` |

“证据次数”的定义因分类而异。例如 React 同时计算 import、hook 调用和 JSX 节点；CSS 每个样式表记一条；ECharts 同时计算 import、类型、运行调用和常见 option 键。因此不能跨分类比较证据次数，也不能据此换算迁移工时或完成百分比。迁移分批时应先使用命中文件数和代表文件定位边界，再进行运行时调用图与用户任务回放。

## 4. 对迁移设计的含义

### 4.1 React/DOM 语料决定迁移分批，不决定原生架构

React 候选覆盖 549 个文件，DOM/CSS/浏览器 API 覆盖 470 个文件。直接把现有组件逐个改写为原生控件会同时触碰布局、输入、焦点、拖拽、剪贴板、无障碍、响应式样式和测试基础设施，无法由 WebGPU 或 `wgpu` 自动承接。

用户最新决策要求最终客户端零 WebView，并由 `wgpu` 绘制全部 GUI。现有正式 Studio 继续冻结保护，但新客户端不能以它为宿主。迁移应先从这些文件抽出可序列化的工作区状态、命令、验证和事件，固化为 golden fixture；Deep retained UI 消费相同协议，不翻译或执行 React 组件源码。

### 4.2 ECharts 适合先建立 `ChartSpec/ChartIR`，再由 DeepChart 接管

ECharts 候选集中在 15 个文件，核心创建、注册、`setOption` 和导出逻辑主要落在少数图表运行文件中。这为建立受控 `ChartSpec/ChartIR` 提供了清楚切面：旧 Studio 保留现有 ECharts 行为作对照；原生客户端自行解析兼容 option，输出 ChartIR、Deep2D 批次和 GPU compute buffer，不加载 ECharts/zrender。

迁移不能把任意 ECharts option 宣称为可无损转换。应先冻结产品实际使用的系列、坐标轴、tooltip、legend、dataset、visualMap、dataZoom、动画和交互事件，再逐项建立对照夹具。

### 4.3 Monaco 继续留在现有 Studio

Monaco 候选只有 6 个文件，却承载编辑模型、语言服务、Worker、诊断、补全、快捷键、输入法、撤销栈和可访问性。现有 Studio 已经承担编辑职责，本轮不在原生 Viewer/Client 内重建代码编辑器。原生客户端只实现运行态确实需要的文本输入与中文 IME，并消费 Studio 发布的版本化 shader、脚本和资源产物。

### 4.4 Worker 与网络已有较集中的宿主边界

Worker 候选为 14 个文件；直接网络 API 候选为 9 个文件，其中本次识别到 6 次 `fetch`、5 次 `WebSocket` 和 1 次 `XMLHttpRequest` 构造。应把这些能力收口到 `HostCapabilities`，保持单一会话、鉴权、取消、重连、顺序和错误语义。旧 Web 行为只作 golden 对照；最终执行适配器全部位于 Rust 原生宿主。

### 4.5 Three/原始图形 API 是渲染迁移的显式清单

Three/原始图形候选覆盖 152 个文件，其中包含 Three 核心、loader、controls、post-processing、TSL/WebGPU、BVH 以及少量 Canvas/WebGL 直接路径。这些文件应与已有 Three AST inventory 联合使用，逐项落到隔离迁移工具、Deep 独立能力或明确不支持合同；Three/WebGL 不得进入原生运行时。

## 5. 已知局限

- 静态扫描不是运行时依赖图；动态生成、远端插件、持久化脚本和发布应用不在语料中。
- 常见 ECharts option 键仍可能出现在非图表对象中；报告把它们标为候选证据。
- TypeScript 绑定用于排除被局部变量遮蔽的 `document`、`fetch` 等名称，但无法证明调用的运行时实现。
- `node_modules` 未扫描；第三方 React/ECharts/Monaco/Three 内部实现和许可证需单独调查。
- 扫描不评估视觉一致性、中文排版与 IME、无障碍、图表语义、GPU 成本、网络时序或故障恢复。
- 命中数不能直接换算迁移工时、风险或能力完成度。
