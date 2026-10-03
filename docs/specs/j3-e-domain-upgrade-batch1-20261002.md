# J3-E 11 域升格第一批(2026-10-02)

owner:J3-E 11 域升格实施者。前置与裁决:
[docs/specs/j3-e-prepresent-promotion-20261002.md](j3-e-prepresent-promotion-20261002.md)(15 域裁决节)、
[test-output/j3-e-prepresent-promote-20261002/domain-upgrade-adjudication.json](../../test-output/j3-e-prepresent-promote-20261002/domain-upgrade-adjudication.json)(11 域 keep-structural,0 升格,逐域四件套前置)。
本批现状核查与全部里程碑:[progress-01/02/03.json](../../test-output/j3-e-domain-upgrade-20261002/progress-03.json)。

## 结论

**2 域完成 GPU 升格**(selection-model-layer-annotation、measurements-annotations),
9 域维持 structural(通道不可达,逐域原因核实成立,见下)。
两独立 fresh 进程 × 各 2 轮 × 2 行 = **8 receipt 全过**:
域引擎通道恢复事务前后逐字段相等 + 同帧号(frame-32)opaque-hdr 相对差 0 +
attempts=1 / stale 拒绝 / disposedResourceCounts 全 0 / author WebGL digest 不变。
证据:[domain-upgrade-receipts.json](../../test-output/j3-e-domain-upgrade-20261002/domain-upgrade-receipts.json)
(run-2026-10-01T23-44-10-264Z / run-2026-10-01T23-44-52-483Z,逐 receipt SHA-256)。

## 升格通道(产品既有链路,零新管线)

裁决书预留的升格路径在本批核出真实载体——**Deep 原生编辑辅助图形 overlay 通道(切片 A/B/C/D,已上线)**:

```
引擎公开写入 API(select/selectAnnotation/addMeasurementVisual/addAnnotation/createPrimitive)
  → 引擎公开读回 getter(getDeepSelectionBox / getDeepMeasurementSegmentInputs /
    getDeepAnnotationInputs / getDeepTransformGizmoInput / listAnnotations / getSelectedAnnotationId)
  → collectDeepOverlayPrimitives(桥构造器注册,StudioDeepWebGpuBridge.ts:164)
  → renderViewDirect(稳态每帧,:612)→ editorOverlay 快照 → EditorOverlayPass(pbrRenderer.ts:761)
  → recovered backend 原生绘制
```

receipt 的域腿读数正是 recovered backend 逐帧消费的确切输入;HDR 同帧号 gate + 恢复
不变量证明恢复事务完整重建并再现。诚实边界:overlay 画在 present 面之后,
opaque-hdr/present-color 捕获均不含 overlay 像素——receipt 不宣称 overlay 像素捕获。

### 两域四件套落点

| 域 | ①读写 API(已存在) | ②probe 装配 | ③恢复事务 | ④recovered 读回 |
|---|---|---|---|---|
| selection-model-layer-annotation | createPrimitive/select/getSelectionScope/getSelectedAnnotationId/selectAnnotation | row A:createPrimitive+select(gizmo+scope 腿);row B:addAnnotation+selectAnnotation(selected-pin 腿) | 选择状态经上述 overlay 通道过全 host 替换 | afterChannels 域腿逐字段相等 |
| measurements-annotations | addMeasurementVisual/deleteMeasurement + getDeepMeasurementSegmentInputs | 两行都装配 distance 测量 | 同上 | 同上 |

引擎真实语义=model/layer/annotation 选择互斥(selectAnnotation 先 select(undefined)),
腿按行拆(model 腿 row A、annotation 腿 row B)。layer 腿需 fragment 加载,维持
CPU-fixture 佐证不 claim GPU;纯 model 选择不建 selectionHelper(viewerEngineRendering.ts:69,
产品语义),model 腿设备呈现=transform gizmo 原语——receipt 逐字声明,不冒充盒腿。

### 9 域维持 structural(原因核实成立)

camera-constraints-navigation(约束值不进渲染输入)、camera-views-default-views(editor
store 无引擎 API)、animation-policy(策略无设备通道)、undo-stack(App 层)、
interaction-scripts-bindings-selectionSets-rootLayerOrder(无装配无通道)、
publication-metadata-thumbnail-simulationEntities(App/store,镜像 getter 属伪管线)、
dashboard-engineering-analysis(需独立装配批)、scene-name-project(editor 层,Native 已内嵌)、
behavior-graph-draft(无探针对象)。全量 scope 见
[domain-upgrade-receipts.json](../../test-output/j3-e-domain-upgrade-20261002/domain-upgrade-receipts.json) editorDomains 节。

**一处裁决书勘误**:selection 域当时记"ViewerEngine/threeBridge 无公开 selection 读写 API"
——实际 ViewerEngine 公开 API 全套已在(select/selectAnnotation/getSelectionScope/
getSelectedAnnotationId/listAnnotations/getDeep*Inputs),当时缺口是 receipt 未接线,本批补接线。

## 本批修复的产品缺陷(升格前置,同族排查落哨兵)

**场景存在测量/批注视觉体时,Deep 切换与恢复失败**("Unsupported editor overlay material."):
`replaceRecoveredBackend` 先 `publishWebGl()`(nativeHelpers=false)→ 候选准备走 CPU overlay
投影 → `createMeasurementVisual`/`createAnnotationVisual` 的 Line/Mesh 材质 `toneMapped`
缺省 true,与深 overlay 投影合同冲突;同场景灯光代理(viewerEngineEnvironment.ts:268-312)
与选择盒(viewerEngineRendering.ts:494)均显式 `toneMapped:false`。修复:sceneOverlayVisuals.ts
四处材质补 `toneMapped: false`;同族回归哨兵入
[deepOverlayDomainChannelReadback.test.ts](../../apps/web/src/viewer/deepOverlayDomainChannelReadback.test.ts)。
复现证据:run-2026-10-01T23-17-49 / 23-20-22 failure(原样保留)。

## 测量方法学(位级 gate 的混杂变量排除,逐项实证)

- **原子同帧捕获**(multi-epoch 20261002 同族竞态修正):settle 与取字节在同一 results
  对象完成;两步 await 曾致 TAA 相位常值族伪差(0.2132/0.2327)。
- **目标帧 8→32**:时域收敛余量。
- **F8 自动曝光**:按真实墙钟 dt 自适应(pbrAutoExposure.ts:226),两 runtime 帧节奏不同
  →半精度末位差;探针后端覆盖为即时收敛(`maxEvPerSecond:1e6, τ:1e-6`)。产品默认不动。
- **第二投影网格的跨设备呈现方差(OPEN 产品发现)**:投影包含第二个网格时,恢复后
  device 对 box 受光面出现间歇、恒值(~2e-3)局部差(diag4:区域 x[164,262]y[150,232];
  SSR/阴影/曝光逐项排除后仍在)。探针侧 row A 的 marker 网格退出投影包(visible=false,
  注册/选择/gizmo 通道保持真实);根因专项另开(疑似 Hi-Z/环境 mip 归约顺序跨 device 差)。

## 独立测试与验收

- 新增 [deepOverlayDomainChannelReadback.test.ts](../../apps/web/src/viewer/deepOverlayDomainChannelReadback.test.ts)
  (6 测试):真实引擎方法体(Object.create(ViewerEngine.prototype)+最小字段,沿
  viewerEngineDeepOverlayRoots.test.ts 既有模式)验证写入 API→Deep 通道 getter 耦合
  (测量/批注/选择 gizmo/选择盒)+ 材质合同同族哨兵 + DeepOverlayPrimitiveViewer 合同对齐。
- 聚焦测试 17 文件 **89/89 绿**(overlay 族 13 文件+恢复域 5 文件,含既有 22 恢复域回归);
  `packages/deep-engine` tsc 通过(本批零 deep-engine 源改动);`apps/web` tsc 通过;
  两次官方 fresh consumed sources 1117、drifted=[]。

## 改动面

- 产品源:`apps/web/src/viewer/sceneOverlayVisuals.ts`(四处材质 toneMapped:false,唯一产品修复);
- 新增测试:`apps/web/src/viewer/deepOverlayDomainChannelReadback.test.ts`;
- 新增探针/runner/证据:`test-output/j3-e-domain-upgrade-20261002/`
  (probe-domain.ts 派生自冻结 probe.ts f03948b2,原文件未动;run.mjs 参数化派生;
  probe-domain-diag.ts 诊断版与中途失败 run 原样保留);
- 未动:jc-i-continuation、冻结 probe/runner、deep-engine 源。

## J3-E 行剩余

mixed unknown/destroyed 序列;第二投影网格跨设备呈现方差专项(open 产品发现);
帧时预算定标;9 个维持 structural 域的后续(各自需独立装配/引擎 API 批);
真实 unknown driver fault 维持永久排除。完整清单承接
[remaining-03.json](../../test-output/j3-e-frame-time-20261002/remaining-03.json)。

## 纪律记录

未 commit/push/reset/clean/stash;四项用户资产未触碰;未调用 cargo(零 native 改动);
GPU 浏览器与其他线路并行,零帧时测量(仅 HDR 同帧号位级比较),每次 run 单 Chrome 实例;
每里程碑先落盘(progress-01 → progress-02 → progress-03 → 本节);失败 run 原样保留。
