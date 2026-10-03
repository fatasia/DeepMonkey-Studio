# J3-E 11 域升格第二批(2026-10-02)

owner:J3-E 11 域升格第二批集成者。前置与底座:
[docs/specs/j3-e-domain-upgrade-batch1-20261002.md](j3-e-domain-upgrade-batch1-20261002.md)(第一批:2 域升格,
9 域维持 structural)、
[test-output/j3-e-prepresent-promote-20261002/domain-upgrade-adjudication.json](../../test-output/j3-e-prepresent-promote-20261002/domain-upgrade-adjudication.json)
(11 域裁决书)。本批现状核查与全部里程碑:
[progress-10/11/12.json](../../test-output/j3-e-domain-upgrade-20261002/progress-12.json)。

## 结论

**2 项升格完成**:

1. **camera-views-default-views(新域,default-view 腿)** —— 一批原因"编辑器层无装配点无读回"
   核实为不完整:`setStandardView(StandardView)` 是引擎公开 API
   (viewerEngineNavigationTools.ts:451,focusBox viewerEngineRendering.ts:458 瞬时生效),
   default-view 应用态=引擎相机位姿/目标/up/模式,正是 renderViewDirect 逐帧输入。
2. **selection-model-layer-annotation(layer 腿补全)** —— 一批遗留"layer 腿需 fragment 加载,
   维持 CPU-fixture 佐证"核实为不完整(与一批 selection API 勘误同族):`selectLayer` 有
   非 fragment 路径(viewerEngineObjects.ts:195-203,经 layerObjects),`registerObject` 对
   一切注册模型递归建层索引(viewerEngineRendering.ts:300-334),公共 `loadManifest` 接受
   data: URL glTF。本腿升为 GPU receipt;fragment(IFC)路径维持 CPU 佐证。

**8 域维持 structural**(逐域复核成立,见下)。measurements-annotations 两行共享装配继续背书。

两独立 fresh 进程 × 各 2 轮 × 2 行 = **8 receipt 全过**
([domain-upgrade-receipts-batch2.json](../../test-output/j3-e-domain-upgrade-20261002/domain-upgrade-receipts-batch2.json),
run-2026-10-02T00-47-04-269Z / 00-47-56-709Z,逐 receipt SHA-256,invariantsAllPass=true):
域引擎通道恢复事务前后 JSON.stringify 全等(含 view/layers 域腿)+ 同帧号(frame-32)
opaque-hdr 相对差 0 + attempts=1 / stale 拒绝 / fatal=0 / disposedResourceCounts 全 0 /
identity 变更 / author WebGL digest 不变。

## 升格通道(产品既有链路,零新管线;与批一同形态)

```
引擎公开写入 API(setStandardView / loadManifest / selectLayer / addMeasurementVisual)
  → 引擎公开读回 getter(相机位姿+getSelectedLayerId+getLayerTree / getDeepSelectionBox /
    getDeepTransformGizmoInput / getDeepMeasurementSegmentInputs)
  → collectDeepOverlayPrimitives+相机视图(StudioDeepWebGpuBridge.ts:164 → renderViewDirect:612)
  → editorOverlay 快照 + 视图矩阵 → EditorOverlayPass(pbrRenderer.ts:761)
  → recovered backend 原生绘制
```

诚实边界沿批一:overlay 画在 present 面之后,opaque-hdr/present-color 捕获均不含 overlay
像素——receipt 不宣称 overlay 像素捕获;相机位姿腿走视图矩阵(HDR 直达)。

### 两域四件套落点

| 域 | ①读写 API(已存在) | ②probe 装配 | ③恢复事务 | ④recovered 读回 |
|---|---|---|---|---|
| camera-views-default-views | setStandardView(六向,瞬时) | row A:createPrimitive 注册单网格 + select(undefined)+ setStandardView('front')(基线断言位姿已偏离入口) | 应用后的相机态经视图矩阵进 recovered 呈现 | camera position/target/up/mode 逐字段相等 + HDR frame-32 drift 0 |
| selection-model-layer-annotation(layer 腿) | loadManifest(data: URL glTF)+ selectLayer | row B:可见 Group 包不可见 Mesh 模型 + selectLayer('root/0') | selectionHelper 盒+层挂 gizmo 经 editorOverlay 通道过全 host 替换 | getDeepSelectionBox/getSelectedLayerId/getLayerTree/gizmo 逐字段相等 |

域语义价值:row A 证的是 CPU 域语义"**现场恢复不替换为入口视图**"——
camera-pose observable(入口视图启动相机)对该回归盲区,default-view 腿以非入口视图装配补上。

### 8 域维持 structural(本批复核成立)

| 域 | 复核结论 |
|---|---|
| camera-constraints-navigation | 约束只在 author 侧塑形位姿(fitPerspectiveBox:459),renderViewDirect 只读位姿;通道不可达 |
| animation-policy | setSceneAnimation/getSceneAnimation 引擎 API 在(viewerEngineSimulation.ts:569/612),但 StudioDeepRenderView 无策略消费;读回仅证未丢失=伪升格 |
| undo-stack | App 层 history hook,无设备通道 |
| interaction-scripts-bindings-selectionSets-rootLayerOrder | 宿主引用容器(SceneGraphHistoryBridge.ts:16 / SceneReferenceCleanupPort.ts:12-14,commands/document 层) |
| publication-metadata-thumbnail-simulationEntities | App/store 文档概念;物理已在 environment observable 域内 |
| dashboard-engineering-analysis | **独立装配批评估后仍维持**:域状态=SceneEngineeringAnalysisState(engineeringAnalysisState.ts:13-17),消费=CPU 纯函数(applyQtoCategoryMapping:92 遍历 author 对象树)+React 面板;无 renderViewDirect 输入/无 overlay 原语/无投影参与;runtimePackage/dashboard* 仅 native 宿主(web bridge 零引用)。装配后无设备通道可读回,升格=伪管线 |
| scene-name-project | sceneName 全在 controllers/store 层(scenePersistenceController.ts 等),引擎无 getter;Native 侧已由 runtime package hash 内嵌(native 口径);补镜像 getter=伪管线 |
| behavior-graph-draft | useAppState 常驻 React 态 |

(9 个一批 structural 域中,camera-views-default-views 本批升格,余 8 域如上;21 域权威矩阵
中 web 非 structural/非豁免域全部有当前批次证据。)

## 本批工程新事实(实测,沿批一方法学)

- **sceneContentBox 以 models 注册表为源**(viewerEngineRendering.ts:22-26):未注册对象
  不进焦点盒——row A 首跑以"default view did not move the camera (empty leg)"装配自证拦截
  (run-2026-10-02T00-43-24 failure 原样保留)。
- **visibleObjectBox 尊重可见性、Box3.setFromObject 不查子级可见性**(sceneObjectUtils.ts:24 /
  three 0.185.1 Box3.expandByObject):"可见 Group 包不可见 Mesh"使层选盒照常成盒且网格退出
  投影包(第二批 row B;与批一 row A marker 同规避族,不触发第二投影网格跨设备方差——
  开产品发现保持 open)。
- **标准视图后相机有阻尼收敛**:focusBox 直接置位姿后,OrbitControls
  enableDamping(viewerEngineCore.ts:441)仍使相机沿曲线继续收敛;author digest 两侧
  位姿不同曾致失败(run-2026-10-02T00-44-56 failure 原样保留)→ 装配内等待位姿逐位稳定
  (连续 3 帧不变)后再进基线。批一未触发是因为从未在装配后移动相机。
- 测量稳定化沿批一:原子同帧捕获 / frame-32 / 自动曝光即时收敛 / SSR 关,产品默认不动。

## 独立测试与验收

- [deepOverlayDomainChannelReadback.test.ts](../../apps/web/src/viewer/deepOverlayDomainChannelReadback.test.ts)
  追加批二 describe(2 测试):setStandardView→引擎相机态耦合(含幂等确定性);
  selectLayer 非 fragment 路径→getSelectedLayerId/getDeepSelectionBox/gizmo/getLayerTree 耦合。
  访问器哨兵扩展 4 项(setStandardView/getSelectedLayerId/getLayerTree/selectLayer)。
- 聚焦测试 10 文件 **74/74 绿**;`packages/deep-engine` tsc 通过(本批零 deep-engine 源改动);
  `apps/web` tsc 通过;两次官方 fresh consumed sources 1117、drifted=[]。
- 范围外观察(如实记录):StudioDeepWebGpuBridge.test.ts 全生命周期 2 失败——该源文件在共享
  工作区被他线修改(git status M,非本批触碰,与本批改动无导入交集),不属本批门。

## 改动面

- 新增探针:`test-output/j3-e-domain-upgrade-20261002/probe-domain2.ts`(派生自第一批
  probe-domain.ts;冻结 probe.ts f03948b2 与第一批 probe-domain.ts 均未动);
- 复用 run.mjs(`J3_DOMAIN_PROBE` 参数化,run.mjs 未动);
- 新增测试:deepOverlayDomainChannelReadback.test.ts 追加(唯一产品仓库内改动,零产品源改动);
- 新增证据:progress-10/11/12.json、domain-upgrade-receipts-batch2.json、
  run-2026-10-02T00-47-04-269Z / 00-47-56-709Z(两 fresh,含截图)及两次失败 run 原样保留;
- 未动:jc-i-continuation、冻结件、批一 receipt、deep-engine 源、产品源。

## J3-E 行剩余

mixed unknown/destroyed 序列;第二投影网格跨设备呈现方差专项(open 产品发现);
帧时预算定标;维持 structural 的 7 域各自前置(引擎 API 批:animation-policy 需设备通道
设计决策;dashboard/scene-name 域为 App 层语义,web 升格需先回答"设备通道是什么",
当前诚实答案是补镜像 getter 属伪管线);真实 unknown driver fault 维持永久排除。
完整清单承接 [remaining-03.json](../../test-output/j3-e-frame-time-20261002/remaining-03.json)。

## 纪律记录

未 commit/push/reset/clean/stash;四项用户资产未触碰;未调用 cargo(零 native 改动);
GPU 浏览器与其他线路并行,零帧时测量(仅 HDR 同帧号位级比较),每次 run 单 Chrome 实例;
每里程碑先落盘(progress-10 → progress-11 → progress-12 → 本节);失败 run 原样保留。
