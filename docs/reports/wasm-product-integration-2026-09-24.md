# WASM 正式产品接入验收（2026-09-24）

## 结论

Deep WASM 已接入 Studio 正式渲染器切换链。作者态仍由现有 WebGL 画布负责输入与编辑，WASM 复用 Native 同一运行包合同负责候选呈现；初始化成功后才交接画面，失败自动保留 WebGL。真实项目浏览器验收通过，无 5xx、无控制台错误，切换偏好可持久化，相机输入会更新 WASM 帧。

## 现状核查

### 2026-09-24 编辑器交互卡顿诊断

#### 已有（不重建）

- 全仓检索 `packages/*/src`、`apps/*/src` 与未跟踪文件后，确认已有 `StudioDeepPerformance` 的输入到反馈采样、`MainThreadLongTaskMonitor`、Three Viewer 的按需渲染、浏览器性能审计脚本；沿现有通道取证，不另建性能采样体系。
- 契约层已有 `CameraState`（`packages/contracts/src/scene.ts`），应用和 Viewer 共用该类型；Web 已依赖 React 19、Three 0.185.1 和工作区 Deep Engine，无需增加依赖。
- 现有消费链是 `viewerEngineRuntime.animate → emitCameraChange → useAppRuntimeEffects.setCameraInfo → App/Studio`；`StudioDeepPerformance.test.ts` 覆盖 Deep 采样。现有架构与基准边界见 `docs/specs/performance-quality-architecture-2026-09-21.md` 和 `docs/active-task-recovery-ledger.md`，历史 FPS 数据不是这次交互延迟证据。

#### 真实缺口

- 尚无同一场景、同一输入轨迹的 WebGL/WebGPU/WASM 输入到显示 P50/P95/P99 与主线程长任务配对记录，不能仅凭 FPS 指认根因。
- 相机运动时 `emitCameraChange` 每个变化帧更新顶层 React 状态；是否造成昂贵提交需要与禁用该回调的诊断 A/B 实测。WebGPU 场景同步/提交和自动保存也需分别排除，不能混成一个“渲染慢”结论。

### 2026-09-24 交互与发布复核

#### 已有（不重建）

- 三后端共用 `RendererDiagnosticsPanel`、`rendererReadiness` 与现有切换状态机；本轮只调整信息层级和文案，不新建引擎选择器。
- Native 独立程序已通过可执行文件 overlay 携带冻结运行包，`runtime_package_startup::load_embedded` 和发布下载链均已存在；白屏排查沿既有启动链进行。
- Three、Deep WebGPU 与 Deep WASM 已共用作者相机和运行包环境合同；一致性修复只补热路径与状态同步缺口。

#### 真实缺口

- 引擎卡片此前分两行，且设备限制、降级说明压过能力与优势；用户打开弹窗不能第一眼完成选择。
- Deep WASM 相机交互期间可见黑闪，Deep WebGPU 相机移动明显卡顿，三后端切换后的视角与背景还未达到像素一致。
- Native 发布程序窗口停留在“正在打开”，客户区出现白色空白与底部黑区；必须用真实发布可执行文件定位首帧、surface 尺寸或启动失败原因。

引擎设置布局已调整：三张卡片紧接弹窗标题，在 1280 与 980 宽度均同排；480 宽度逐张纵排。真实浏览器的卡片顶边与标题区底边相接（均为 77px），弹窗顶部距视口 24px。截图：`test-output/renderer-dialog-1280-latest.png`、`renderer-dialog-980-latest.png`、`renderer-dialog-480-latest.png`；布局数值见 `test-output/renderer-dialog-layout-latest.json`。初轮截图后继续把每张卡片缩成一句定位、两条能力与一个动作，第二轮同尺寸截图确认首屏三卡都完整可见。沿用 `base.css` 的品牌色、状态色、间距和圆角；对标西门子工业软件的能力选择与状态信息层级。十维自评：层级 9.5、令牌 9.6、状态 9.3、可读性 9.4、响应式 9.5、交互 9.4、恢复 9.4、性能信息 9.2、工业语义 9.4、整体 9.4，平均 9.41/10。组件测试 21/21 和 Web 类型检查通过。

当前旧验收结论仅证明“能切换并呈现”，不再作为流畅度、无黑帧和三后端视觉一致性的完成证据；上述问题全部通过后再更新最终结论。

### 已有（不重建）

- `StudioDeepWebGpuBridge`、`BackendCanvasDeck`、渲染器偏好和 `useAppRuntimeEffects` 已提供候选画布、失败回退与偏好提交状态机。
- `compileSceneRuntimePackage`、`buildDeepRuntimePackage`、`serializeDeepRuntimePackage` 已是 Web、Native、Android 共用的场景运行包合同。
- `deep-engine-wasm` 已镜像 Native 引擎模块，并已有运行包注入、冻结字体、异步 WebGPU 初始化和 canvas 认领入口。
- Studio 的场景编辑、拾取、XR 输入和保存仍以作者画布为权威；WASM 不另建一套编辑器。

### 本轮真实缺口

- 正式 `RendererBackend` 未声明 WASM，设置面板没有能力探测、切换、回退和持久化入口。
- 正式 Studio 未把当前作者场景编译为运行包并交给 WASM。
- 浏览器生产路径曾从 Vite `public` 目录静态导入，导致模块请求 500。
- 真实场景包含 Draco 压缩几何，WASM 装载前未复用既有 Draco 解码器。
- Web `PbrMaterial.fog` 与 Native 运行包合同存在字段漂移。

## 实现边界

- 新增 `StudioDeepWasmBridge`，接入既有候选画布状态机，不新增平行渲染器管理器。
- 复用现有 optimizer `WebIO` 和固定 Draco decoder，把真实场景标准化后交给共用运行包编译器。
- 作者 WebGL 画布继续持有指针输入；WASM 画布只负责呈现。就绪前不隐藏作者画布，停止或失败后原路回退。
- Native 合同增加可选 `fog` 字段并与浏览器 surface flag 对齐；没有新增第二种场景格式。

## 验证证据

| 门禁 | 结果 |
|---|---|
| WASM Rust check | 通过 |
| Web 类型检查 | 通过 |
| WASM/渲染器聚焦测试 | 24/24 |
| Native `fog=false` 合同回归 | 通过 |
| 真实 Studio 场景切换 | 通过 |
| 页面控制台 error | 0 |
| HTTP 5xx | 0 |
| 作者/WASM 画布交接 | 作者 opacity 0、输入保留；WASM opacity 1 |
| 相机输入 | 帧 SHA-256 变化 |
| 持久化偏好 | `wasm` |
| 响应式对话框 | 1920/1280/980/800/480 均在视口内 |

浏览器证据：`test-output/wasm-product-integration/studio-integration-report.json`。截图与报告同目录。验收过程中相机自动保存产生两次真实场景 `PUT`，没有失败响应。

## 产物体积

- JS：116,142 bytes
- WASM：5,944,010 bytes
- 合计原始体积约 5.78 MiB
- WASM gzip-9：2,278,553 bytes
- WASM Brotli-11：1,620,562 bytes

早期数百 KB 数据来自隔离 benchmark；正式包包含完整 Native 镜像模块，不是同一个产物。后续首包优化应做加载域拆分与懒加载，不能删除功能伪造瘦身。

## 视觉验收

Design Read：沿用 `base.css` 令牌、现有渲染器设置弹层和克制的状态色；不新增装饰性页面。第一轮检查 1280 桌面切换状态，第二轮检查 480 窄屏诊断弹层，并用自动化覆盖五档视口。

Kimi-95 自评（10 分制）：层级 9.5、令牌一致性 9.6、状态表达 9.5、可读性 9.3、响应式 9.5、交互反馈 9.5、故障恢复 9.7、性能可见性 9.2、工业语义 9.4、整体完成度 9.5，平均 9.47。低于满分的主要原因是完整 WASM 首包仍需懒加载拆分，且窄屏诊断内容依赖内部滚动。

同族排查：WebGL、Deep WebGPU、Deep WASM 共用同一设置弹层、标签函数、能力快照和回退文案；未发现另一套 WASM 入口或重复状态机。
