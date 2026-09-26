# 编辑器 React↔3D 边界性能审计(对标 R3F)

日期:2026-09-27 · 类型:只读审计 + 探针实测(未改任何运行时源码)
范围:`apps/web/src` 的 React↔ViewerEngine/Deep 桥接层
探针:`apps/web/scripts/probe-react-render-audit.mjs`(新增,未提交)
数据:`test-output/react-audit/react-render-audit.json`(逐 commit 明细)、`test-output/react-audit/summary.json`(场景汇总)

---

## 0. 现状核查(任务前置)

- `git status`:另一会话正在治理 `useEditorPresence.ts`(1Hz 驱动轮询)与 `useAppState` 相机/指针分片。本审计对这两个文件的现状只做**清点与交叉验证引用**,不提修改其内部实现的具体 patch;涉及处标 ⏸(移交边界)。
- 已实锤背景复核:Deep 拖拽期长任务 = React 同步重渲染;`deepCameraInputSession.ts:102-106` 已在手势期不转发 pointermove(注释即写明 50-100ms 长任务实测),本审计在其之上做**全量清点**。
- 引擎侧已有等价物(不重建):`ViewerRenderDemand`(demand/invalidate)、`ViewerEngineCore.subscribeCameraChange`(帧级相机旁路)、`EngineViewOrientationCube`(transient 直写 DOM)、`emitCameraChange` 原始值快速路径、`presentationFrameListeners` 帧订阅。
- 相关历史文档:`docs/reports/deep-core/`、`docs/specs/deep-engine-core-capability-development-plan-2026-09-27.md`;本报告不与之冲突,只补 React 边界视角。

### 测量环境与口径(必读)

- Vite dev 构建 + **StrictMode**(apps/web/src/main.tsx:22)→ 函数组件渲染计数 ≈ 生产语义 ×2,commit 数不受影响。下文 renders 均为 dev 计数。
- 场景 fedab835("678 - 副本",`interactions=0`,经 API 核实);1280×800 headless Chrome;WebGL 作者画布(Deep 桥同挂载)。
- DevTools hook 注入:`__REACT_DEVTOOLS_GLOBAL_HOOK__.onCommitFiberRoot`,按 `flags & PerformedWork` 统计每个 commit 的重渲染函数组件(为 0 时退回 `actualStartTime` 窗口),并记录每 commit 的组件 TOP-6、actualDuration 累计、longtask。
- 归因方法:hook 链逐 commit diff + hook 签名与源码声明顺序逐位对照(见 §2.4)。

---

## ① 高频源 → setState 路径全量清单

频率分级:🔴=每帧/每事件(30-60Hz) · 🟠=亚事件级节流(10-30Hz) · 🟡=定时节流(1-13Hz) · 🟢=低频(≤1Hz)。"壳"指 `App` 巨 hook(useAppState,约 120 个 useState)驱动的整棵工作区树。

### A. 引擎 → React 桥(viewer 层)

| # | 源 | 链路 | setState 位置 | 消费组件 | 频率 | 影响面 |
|---|---|---|---|---|---|---|
| A1 | gizmo 拖拽中每次 pointermove | TransformControls `objectChange`(viewerEngineCore.ts:456-483,经 :481 `onModelChange`)→ useAppRuntimeEffects.ts:269-272 | `requestRevision` → rAF 合并 `setRevision`(:239-246);附带 `recordSceneEdit`(220ms 防抖后全场景快照,useSceneHistoryState.ts:55-63) | 全壳(App) | 🔴 实测 31-54Hz commit(§2 场景 S7b) | 全壳:每次 commit 约 100 个函数组件(dev 计数)重渲,含 WindowedSceneRows/MeasuredRow/Inspector |
| A2 | gizmo 拖拽中选中灯光时 | 同上 `objectChange` → viewerEngineCore.ts:458-469 `onLightingChange` | useAppRuntimeEffects.ts:273-277 `setLighting` | 全壳 | 🔴 每事件,**无任何节流/合并** | 全壳;且每次构造新 GlobalLightingState |
| A3 | 指针移动(信息面板开启时) | canvas pointermove → `handlePointerMove`(viewerEnginePointer.ts:314-333,异步全场景 raycast :321)→ :325 `onPointerInfoChange` → useAppRuntimeEffects.ts:597 **裸 `setPointerInfo`,无节流** | useAppState.ts:161 | SceneInspectorInfo(AppStudioInspector.tsx:106)及全壳 | 🟠 实测 26-35Hz(受 raycast 异步完成率限制,:320-322 序号防乱序) | 全壳;唯一好消息:信息关闭时 :317 早退,零成本 |
| A4 | 场景动画播放中每帧 | animate → viewerEngineRuntime.ts:88-91(80ms 节流)`onAnimationChange` → useAppRuntimeEffects.ts:311-314 **两个 setState** | `setAnimationTime`+`setAnimationPlaying`(useAppState.ts:211-212) | SceneTimelinePanel currentTime(AppStudioViewport.tsx:622)+ 全壳 | 🟡 实测 13.9-14.3Hz(=80ms 节流) | 全壳;为驱动一条进度条重渲整树 |
| A5 | 每个渲染帧 | animate → viewerEngineRuntime.ts:118 `emitCameraChange`(原始值去重 :283-299)→ `onCameraChange` → cameraInfoPublisher 250ms 合并 + `startTransition`(cameraInfoPublisher.ts:21-53,useAppRuntimeEffects.ts:586-588) | `setCameraInfo`(useAppState.ts:160) | SceneInspectorInfo | 🟡 ≤4Hz,transition 化 | 全壳(低频);仅 infoEnabled 时挂载 |
| A6 | 每个渲染帧(旁路) | 同 emitCameraChange → `subscribeCameraChange`(viewerEngineCore.ts:136-152)→ EngineViewOrientationCube(AppStudioViewport.tsx:716-747) | **不经 React**:每帧直写 `style.transform`,80ms 静置后才 `setCamera`(局部) | 罗盘自身 | 🔴 每帧 | 仅局部;**这就是本仓库的 R3F transient 正确范式** |
| A7 | gizmo 拖拽起止 | TransformControls `dragging-changed`(viewerEngineCore.ts:446-455) | **无 setState**(仅引擎侧 orbit 开关与物理体重建) | — | 🟢 每次 | 这是 P0-3 的现成挂点:拖拽落定提交应挂在这里 |
| A8 | 第一/三人称碰撞移动 | resolveCharacterMovement → viewerEngineRuntime.ts:504-507(250ms 节流)`onNavigationDiagnosticsChange` | `setNavigationDiagnostics`(useAppRuntimeEffects.ts:282) | 导航调试 UI | 🟡 4Hz | 全壳;默认关闭时低频 |
| A9 | 每帧 | updateCollisions(viewerEngineRuntime.ts:105)→ `onCollisionChange`(有变化才发)→ useAppRuntimeEffects.ts:279 `requestRevision` | `setRevision` | 全壳 | 🟢 300ms 节流且仅变化时(viewerEnginePointer.ts:63-67) | 条件性 |
| A10 | 选中变更(pointerdown) | `onSelectionChange` → useAppRuntimeEffects.ts:258-268 → `synchronizeSelectionFromViewport` | `setSelected`/`setSceneOrganizationSelection`/`setRevision` | 全壳 | 🟢 每次点击 | 全壳一次,合理 |
| A11 | 场景数据消息 | subscribeSceneData → useAppRuntimeEffects.ts:734-748 | `setSceneDataReceived`(+1)+ 命中时 `setRevision` | 全壳 | 🟡 取决于数据源频率 | 全壳 |
| A12 | 测量/标注/剖切拾取 | viewerEnginePointer.ts handlePointerDown 系列 → 对应回调 | 各 setter + `setRevision` + `setMessage` | 全壳 | 🟢 每次点击 | 全壳一次,合理 |

### B. 定时器/轮询(全壳提交基线)

| # | 源 | setState | 频率 | 影响面 |
|---|---|---|---|---|
| B1 | frameRate 采样(useAppRuntimeEffects.ts:674-683) | `setFrameRate` | 🟢 500ms,仅 infoEnabled | 全壳 |
| B2 | 项目同步轮询(useAppSceneSyncEffects.ts:57) | `setScenes`/`setProject` 等 | 🟢 2500ms | 全壳 |
| B3 | 编辑器存在心跳/驱动轮询(useEditorPresence.ts:12-14) | 订阅 revision/租约状态 | 🟢 15s 心跳 + 1s 驱动轮询 | ⏸ 另一会话治理中;实测空闲基线 1.2-1.6 commit/s 与其相关(见 §2 S1) |
| B4 | 数据绑定轮询(useAppRuntimeEffects.ts:750-831,:824) | `setSceneDataBindingRuntime` | 🟢 ≥2s/组 | 全壳(面板打开时) |
| B5 | 视觉事件轮询(useAppRuntimeEffects.ts:833-891,:886) | `setMessage` | 🟢 2000ms | 全壳 |
| B6 | 渲染诊断采样(useRendererDiagnostics.ts:71) | 局部 state | 🟢 500ms,仅诊断面板开启 | 局部 |
| B7 | 数据回放 tick(DataReplayPanel.tsx:52) | `setTick` | 🟡 250ms(面板局部) | 局部 |
| B8 | 拓扑运行时钟(TopologyEditorPanel.tsx:143)、AI 历史(AiDataRunHistory.tsx:20,10s)、视觉 QA(ViewerVisualQa.tsx:226,500ms) | 各局部 state | 🟢 | 局部 |

### C. React 侧手势/窗口(不经引擎)

| # | 源 | setState | 频率 | 影响面 |
|---|---|---|---|---|
| C1 | 2D 看板节点拖拽(dashboardNodeTransform.ts:69) | `setDraftFrames`+`setActiveSnapLines` | 🔴 每 move | DashboardWorkspace 子树(非全壳;拖拽预览走 React 属 transient 误用,见 §3) |
| C2 | 看板滚轮缩放/平移(dashboardCanvasController.ts:69,84,94) | `setZoom`/`setViewportScroll` | 🔴 每事件 | 看板子树 |
| C3 | 面板拖拽/分栏(useFloatingPanelDrag、SceneTimelinePanel.tsx:266、BehaviorScriptListResizer) | 局部 state/direct DOM | 🔴 每 move | 局部 |
| C4 | 窗口 resize(WindowedSceneRows.tsx:49 scheduleViewport;AppBehaviorOverlay.tsx:50) | 局部 | 🟢 | 局部 |

**结论(全量表)**:全壳级高频源共 5 条——A1(gizmo)、A2(灯光 gizmo)、A3(pointer info)、A4(动画时间)、A5(相机 readout);其余要么局部要么低频。其中 A3/A5 已有节流/transition 但仍打全壳,A1/A2/A4 完全没有隔离。

---

## ② TOP-10 重渲染实测表

探针:8 个场景,每 commit 记录组件级计数与 actualDuration;分支口径 = 该分支子树内每次 commit 的重渲染组件数(故分支总数 ≥ App commit 数)。

### 实测场景矩阵(本 dataset + 3 次有效重复运行区间)

| 场景 | commits | 全壳重渲组件(dev 计数)/次 | 时长 | 判定 |
|---|---|---|---|---|
| S1 空闲 2.5s | 3-4(1.2-1.6Hz) | ~100/commit | 2.5s | 轮询基线(B1-B5),每次提交全壳 |
| S2 悬停(信息关) | 3(≈空闲) | ~100/commit | 1.9s | ✅ 悬停零成本(早退生效) |
| S3 动画播放 3s | 43-44(≈14Hz) | ~100/commit,4585-4497 总渲染 | 3.1s | 🔴 A4 实锤 |
| S4b 悬停(信息开) | 63-65(26-35Hz,拥挤运行取下限) | ~105/commit,6615-7020 | 1.9-2.5s | 🔴 A3 实锤 |
| S5 轨道拖拽(干净会话) | **0 组件重渲染** | 0 | 4s | ✅ 相机路径已等价 R3F(独立对照运行) |
| S5' 轨道拖拽(会话被污染*) | 182-239(40-55Hz) | ~100/commit | 4.5s | 🔴 见 §2.4 未决归因 |
| S6 滚轮×15 | 13-21 | ~100/commit | 1.3s | 🟠 阻尼帧+A5 残留 |
| S7a gizmo 点选 | 4-6 | ~100/commit | 0.6s | 🟢 合理 |
| S7b **gizmo 拖拽** | 116-123(31-54Hz) | ~100/commit,11918-12900 总渲染,longtask 1-10 | 2.3-3.7s | 🔴 **A1 实锤,P0** |

\* "污染"定义见 §2.4:同页面先开/关过导演台或信息面板后再拖拽。**这正是真实编辑会话的常态**,不能按"干净会话"豁免。

### TOP-10 组件(全审计会话累计,dev 计数;ms=actualDuration 累计)

| # | 组件 | 渲染次数 | 累计 ms | 角色 | 每次 ms |
|---|---|---|---|---|---|
| 1 | App | 1080 | 4077.5 | 巨 hook 根;每个全壳 commit 必到 | 3.8 |
| 2 | AppRootView(分支) | 2525 | 4003.8 | 整棵工作区 | — |
| 3 | AppStudioShellView(分支) | 2525 | 3812.7 | 3D 工作台壳 | — |
| 4 | AppStudioInspector(分支) | 3676 | 1186.4 | 属性检查器 | — |
| 5 | SceneToolDock(分支) | 5100 | 246.3 | 工具坞(DockButton×7 每壳渲染) | — |
| 6 | ObjectAppearanceFields(分支) | 6156 | 235.5 | 外观编辑组 | — |
| 7 | SceneOutlinerPanel(分支) | 2020 | 934.9 | 场景目录 | — |
| 8 | WindowedSceneRows | 2062 | 916.0 | 虚拟滚动行容器 | 0.44 |
| 9 | MeasuredRow | 2057 | 869.5 | 目录行(已 memo;`bind` 已 useCallback 稳定(WindowedSceneRows.tsx:73),但 `row` 对象随父渲染重建、identity 失效) | 0.42 |
| 10 | AppStudioViewport(分支) | 1556 | 555.9 | 视口组合层 | — |

补充:TransformFields 分支 4617 次/26.8ms(便宜但高频);SceneLayerInteractions 1539 次/662.3ms(单次 0.43ms,贵);SceneRowMenu 2063 次/477.5ms。
**最贵子树判定**:按累计 ms,`App→AppRootView→AppStudioShellView` 是唯一"每次必到"的路径;叶片上最贵的是**场景目录行簇(WindowedSceneRows+MeasuredRow+SceneRowMenu ≈ 2.2ms/commit)** 与 **SceneLayerInteractions**。属性检查器(AppStudioInspector)单次 0.32ms × 高频,总量第二。

---

## ③ transient / reactive 分层审计

判定准则(源自 R3F):**语义上"每帧/每事件都在变、且只被 1-2 个视觉元素消费"的状态是 transient,应留在 React 外(useFrame 等价物 + ref/DOM 直写);"跨手势稳定、被业务逻辑或持久化消费"的才是 reactive。**

| 状态 | 现状层 | 应属层 | 依据 |
|---|---|---|---|
| 相机矩阵/罗盘朝向 | ✅ 已正确:订阅旁路 + DOM 直写(A6) | transient(维持) | AppStudioViewport.tsx:723-735 |
| 相机 readout(cameraInfo) | 🟡 React,250ms+transition | transient(读数用 DOM 直写即可;若保留 React,至少切片出 App) | 消费者仅 SceneInspectorInfo |
| 指针坐标/拾取对象名(pointerInfo) | 🔴 React 裸连(A3) | transient;拾取结果里"对象名"进状态栏即可,坐标直写 | 同上;且 raycast 本身应 48ms 节流(hover 已有,info 路径没有) |
| 动画播放头(animationTime) | 🔴 React 14Hz(A4) | transient:播放中进度条由 rAF 直写宽度;**暂停/seek/落点才 setState** | 消费者仅时间线进度 UI |
| gizmo 拖拽中值(objectChange) | 🔴 setRevision 全壳(A1) | transient:拖拽中 TransformControls 自绘 + 属性面板数字用 ref 直写;**pointerup 落定才 setRevision+快照** | A1 的消费本质是"面板数字跟随",不是业务状态变更 |
| 灯光拖拽中值(onLightingChange) | 🔴 每事件 setLighting(A2) | transient 同上;灯光面板数字拖拽中直写,pointerup 提交 | 同上 |
| 帧率读数(frameRate) | 🟢 React 500ms | transient(可 DOM 直写) | 消费者仅 FPS 数字 |
| 看板拖拽草稿(draftFrames) | 🔴 React(C1) | transient(拖拽中 transform 直写,up 才提交) | 与 A1 同机制 |
| 选择变更、模式切换、资产增删、环境/灯光参数提交、历史事务 | ✅ React | reactive(维持) | 跨手势稳定、驱动持久化与业务 |
| 应用文档/变量(ApplicationStore) | ✅ React 外 store + useSyncExternalStore | reactive(维持) | dispatchInteraction 仅在选中/变量真实变化时 emit(applicationStore.ts:176-190) |

---

## ④ R3F 模式差距清单

| R3F 机制 | 本仓库现状 | 差距/可借鉴 | 等价? |
|---|---|---|---|
| 帧循环在 React 外(`useFrame` 注册表) | `animate`(viewerEngineRuntime.ts:31-132)自持 rAF;`presentationFrameListeners` 提供帧订阅 | 缺"任意模块按优先级订阅每帧回调"的正式注册表,目前靠引擎内部固定调用序 | ≈等价,无注册表 |
| transient 更新不经 setState(useFrame+ref) | 仅罗盘一处(AppStudioViewport.tsx:716-747);时间线/属性面板/指针读数全走 setState | **最大差距**:A1-A4 四条热路径应改为帧订阅+ref 直写 | ✗ |
| frameloop="demand"/invalidate | `ViewerRenderDemand` invalidate/settle/continuous(viewerRenderDemand.ts:8-32)+ `setContinuousRender` 白名单 | 语义一致且多了 settle 与成本记账 | ✅ 已等价 |
| 命令式 ref 操作(applyProps diff) | 无 React reconciler 参与场景图;引擎是唯一写者 | 天然规避了 R3F 的 reconcile 成本;不需要 applyProps | ✅ 超越 |
| store 订阅选择器(zustand) | ApplicationStore + useSyncExternalStore(useAppState.ts:152)是正确骨架;但旁路 120 个 useState 把一切又拉回全壳 | 缺**切片订阅**:useSyncExternalStore 只有一个快照,粒度=整个 App | ✗ |
| 按需渲染消费者( only render when props change) | 全 views/components 仅 2 处 memo(DashboardTemplatePreview.tsx:28、WindowedSceneRows.tsx:163;且 MeasuredRow 因 `bind` 内联 props 失效) | bindings 对象每渲染新建(App.tsx:702-734)→ memo 无从生效 | ✗ |
| instancing/批处理(渲染侧) | RepeatedAssetBatcher、conservativeOcclusion、shadowUpdateGovernor 等已自建 | 非 React 边界问题 | ✅ 已等价 |
| 事件系统按需 raycast(R3F pointer 事件走同一帧循环) | pointermove raycast 由 infoEnabled 驱动、无固定节流(viewerEnginePointer.ts:314-333) | hover 有 48ms 节流(:318),info 路径没有;统一为同一节流+仅 infoEnabled 且面板可见时才 raycast | ✗ |
| Suspense/transient 加载 | viewerLoadState 走 React,低频 | 无差距 | ✅ |

**一句话**:渲染循环、demand、批处理、遮挡这些"引擎内功"已经达到甚至超过 R3F;唯一系统性落后的是 **transient 状态通道**——R3F 有 `useFrame+ref` 这条专用高速公路,本仓库所有"跟随类"状态都在挤 setState 国道,而出口(全壳 App)又没有切片。

---

## ⑤ ROI 修复路线图

### P0——直接消长帧(全部是"把热路径移出全壳 setState",互相独立,可逐条落地)

| # | 措施 | 最小切片 | 预期 | 成本 |
|---|---|---|---|---|
| P0-1 | **动画播放头脱离 React**:onAnimationChange 播放中不再 setState;SceneTimelinePanel 进度条经 `subscribeCameraChange` 式帧订阅直写宽度;暂停/seek/落点才提交 | useAppRuntimeEffects.ts:311-314 改为条件提交;时间线加 ref 进度条 | 播放期 ~14Hz 全壳 → ~0 | S |
| P0-2 | **pointer info 节流+降级**:A3 路径复用 hover 的 48ms 节流,`setPointerInfo` 降为 200-250ms 合并(复用 cameraInfoPublisher)或坐标 DOM 直写;对象名变化才提交 | viewerEnginePointer.ts:314-333 + useAppRuntimeEffects.ts:597 | 悬停 33Hz 全壳 → ≤4Hz;raycast 同步降载 | S |
| P0-3 | **gizmo 拖拽落定制**:objectChange 期间挂"拖拽中"标志;属性面板 TransformFields 数字改 ref 直写(或 250ms 合并);`setRevision`+`recordSceneEdit` 移到 `dragging-changed=false`(viewerEngineCore.ts:446-455 已有该事件) | viewerEngineCore.ts:456-483 + useAppRuntimeEffects.ts:269-272 | 拖拽 42-53Hz 全壳 → 0(落定时 1-2 次) | M |
| P0-4 | **灯光 gizmo 同族清剿**:A2 与 P0-3 同机制(setLighting 移到 dragging-changed=false) | viewerEngineCore.ts:458-469 | 同上 | S |
| P0-5 | **污染会话归因补刀**(§2.4):在 `requestRevision`(useAppRuntimeEffects.ts:239-246)加 dev-only 计数器+栈采样,一次复现即可定位触发回调 | 一行计数器 + 复现步骤 | 关闭最后的未知全壳源 | S |

### P1——减子树渲染(把全壳变局部)

| # | 措施 | 最小切片 | 预期 | 成本 |
|---|---|---|---|---|
| P1-1 | **相机/指针/帧率/动画时间 state 切片**(⏸ 与另一会话合流):这四个高频值从 useAppState 巨 hook 迁到独立外部 store(复用 ApplicationStore 模式)或 Context+useSyncExternalStore,消费面仅检查器信息卡 | useAppState.ts:160-163,211-212 迁出 | 残余全壳提交(轮询基线 B1-B5)从 ~100 组件降到 <20 | M |
| P1-2 | **bindings 稳定化**:AppViewBindings 按域 memo(useMemo 分域 + useCallback 化控制器),给 AppStudioShell/Topbar/Overlays 包 memo | App.tsx:702-734 | P0 落地后的残余提交只影响真实消费者 | M |
| P1-3 | **行簇 identity 稳定化**:rows 数组按 revision 缓存(或 row 传 key+稳定句柄),让 MeasuredRow 的 memo 真正生效;SceneLayerInteractions/SceneRowMenu 同法下沉局部状态 | WindowedSceneRows.tsx:73,154,163 | 目录行簇 2.2ms/commit → ~0 | S |
| P1-4 | derivedState 高成本项节流:`bindingComponents` 搜索上限 10000(useAppDerivedState.ts:73)与 `interactionTargetOptions` 2500 项(useAppState.ts:240-250)按 revision 增量/降频(拖拽中跳过) | 两处 useMemo 条件化 | 每全壳 commit 的 CPU 尾巴减半 | S |
| P1-5 | 2D 看板拖拽 transient 化(C1/C2,与 P0-3 同模式) | dashboardNodeTransform.ts:69 | 看板拖拽 60Hz React → 0 | S |

### P2——架构演进

| # | 措施 | 说明 |
|---|---|---|
| P2-1 | **把"引擎→UI 读数"统一成一条帧订阅通道**:正式化 `presentationFrameListeners`/`subscribeCameraChange` 为带优先级的 `useEngineFrame(cb)` hook(对齐 R3F useFrame),新增跟随类 UI 一律走它,禁止再开 setState 通道 | 防回归的制度化 |
| P2-2 | **巨 hook 拆域**:useAppState 按 域拆为多个 store/useSyncExternalStore 切片(编辑域/持久域/会话域/transient 读数域),App 只订阅"域存在性" | 大工程;待 P1-1 验证模式后推进 |
| P2-3 | **prod build 复测门禁**:当前所有数据来自 dev+StrictMode;上线前用 profiling 构建复测 §2 矩阵,确认 renders/2 ≈ prod | 与 CI 集成 |

### 建议实施顺序
P0-2 → P0-1 → P0-3+P0-4(同族) → P0-5 → P1-3 → P1-1(合流) → P1-2 → P1-4 → P1-5 → P2。
每步以本探针复测对应场景为验收(commit 频率降一个数量级为过线)。

---

## 2.4 补充:未决归因(诚实条款)

- **"污染会话"的轨道拖拽 40-55Hz 全壳提交**:同一页面先开/关"场景信息"或"导演台"后,后续轨道拖拽每 move 触发一次 `setRevision`。已实锤:变化 hook = App hook 链 #54 = `revision`(useAppState.ts:116;hook#50-63 签名与源码顺序逐位对照)。**未实锤:引擎侧触发回调**(requestRevision 的三个引擎触发源 onModelChange/onCollisionChange/拾取回调在轨道场景下按代码都应不发;新页面直接拖拽为 0 组件渲染)。已排除:交互脚本(场景 interactions=0)、TransformControls objectChange(仅拖拽轴时发,three TransformControls.js:768-769 在 drag 分支内)、store 交互链(仅在选中/变量变化时 emit)。→ P0-5 的计数器是收尾手段。
- **未测量项**:① Deep WebGPU 模式下的本轮重渲染矩阵(本审计仅 WebGL 作者画布;Deep 拖拽长任务已由既有探针实锤,未重跑);② 生产构建下的绝对耗时(dev 的 actualDuration 约高 2-5×);③ 首帧/场景恢复期的提交分布(仅采到"恢复后 revision=7"的旁证);④ S6 滚轮在干净会话下的 commit 成分(13-21 次/1.3s 未逐个归因)。
- 探针自身限制:DevTools hook 注入不改应用行为,但逐 commit 全树 walk 在 60Hz 提交期会给主线程加轻微观测开销;结论均基于**相对频率与计数**,不受其影响。

## 交叉验证锚点(供另一会话合流)

- 另一会话若已把 cameraInfo/pointerInfo 切出 App(P1-1 的子集),则本报告 A3/A5 的"全壳"结论应下调为"局部",其余路径(A1/A2/A4)不受影响。
- 本报告不重复深水区:useEditorPresence 轮询治理、Deep 长任务归因(已有 `docs/reports/deep-core/` 与既有探针)。
