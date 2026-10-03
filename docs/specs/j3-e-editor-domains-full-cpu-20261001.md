# J3-E 21编辑域 CPU 覆盖与动画元数据修复

本切片覆盖P2作者恢复的实际capture/controller/readiness消费链及常驻React域。P1未知驱动故障和GPU帧级恢复仍需独立实测。

## 现状核查

1. 检索packages/apps src中makeSceneSnapshot/rendererSnapshotRef/restore/unknown/ViewerSnapshotReadiness，检查未跟踪文件。上一刀已修相机、最终播放头和严格恢复失败重试；复用这些能力。
2. 已读SceneSnapshot/SceneModelState/PrimitiveState、动画/选择/测量/标注合同、RendererRecoveryState和ScenePersistenceControllerContext。21域唯一声明沿用scripts/lib/j3UnknownLossMatrix.mjs。
3. React/Three/Vitest/TypeScript已安装；无新增依赖。Native/GPU工具不在本子线运行。
4. 实际makeSnapshot→makeSceneSnapshot→captureSceneModelState；applyScene→模型加载/作者setter/readiness；renderer helper→唯一runtime consumer。history按activeScene.id重置，behavior draft在useAppState常驻。状态机由编辑器、状态过渡、运行包编译器消费；autoplay由时间线作者面板和发布播放路径消费。
5. 上一刀75测试；已有readiness、snapshot、history、Play、Navigation和状态机测试。缺13快照域与实际代际取消组合回归，故补输入与调用覆盖，不重写协议。
6. 已读editor-state-cpu、gpu-runner-prep、editor-domain-recovery、Gate E lifecycle/window-recovery、remaining和ledger。当前切片只收CPU范围，不关闭Gate E完整行。

已有（不重建）：实际capture/controller/readiness、严格P2恢复、瞬时动画channel、对象状态读取、历史栈/行为草稿、session恢复状态机、Native真实Presented装配。

真实缺陷：ViewerEngineSimulation.setSceneAnimation重建对象漏stateMachine/autoplay，导致实际getSceneAnimation→capture丢作者字段；sceneImportRebinding只迁移动画关键帧模型ID，遗漏状态机states[].modelId，旧格式模型导入后指向已不存在的旧ID。

## 实现

- 动画setter保留显式autoplay；stateMachine使用structuredClone防输入后续编辑污染引擎状态。字段缺省仍缺省，后续不含状态机的更新会清除旧配置。既有排序、speed/range clamp和暂停语义保持。
- 导入状态机引用复用既有rebindId，旧格式modelId迁移，显式独立实例身份保持；不修改输入场景。
- 所有新测试叶16–78行。现场输入先经实际migration→SceneDocument结构校验，含合法gltf:1材质槽、nodeId层状态、三人称/头像、非默认灯光/天气/后处理/坐标系。
- 实际ViewerEngineSimulation原型set/get/seek在CPU host上执行，构造器/GPU未运行；真实控制器、快照工厂、readiness、React状态/历史hook执行。模型下载、ViewerEngine资源和React调度由明确fixture边界提供。

## 21域证据层级

| 域（沿用既有矩阵顺序） | 本轮实际CPU检查 | GPU完成状态 |
|---|---|---|
| 1 camera pose/mode/avatar | 现场位姿、thirdPerson、头像可见往返 | 未据此升级 |
| 2 camera constraints/navigation | 非默认约束、步行/飞行设置capture→setter | 未据此升级 |
| 3 camera views/default | 命名默认视图载体保留，现场恢复不替换为入口视图 | 未据此升级 |
| 4 model/primitive pose/material | 实例/资产ID、变换、IOR/材质槽、图层/锁定、图元消费 | 未据此升级 |
| 5 model/layer/annotation selection | 实际三分支及标注优先级 | 未据此升级 |
| 6 measurements/annotations | capture→实际视觉setter与UI载体 | 未据此升级 |
| 7 environment/lights/weather/floors/postfx/physics/section/axis | 真实mip carrier、作者参数/坐标系全部消费 | 未据此升级 |
| 8 animation policy | 实际引擎元数据保留、别名隔离、缺省清除、导入引用 | 未据此升级 |
| 9 animation playhead | 上一刀实际channel最终值/clamp；本刀实际原型seek | 未据此升级 |
| 10 undo stack | 实际history hook同scene ID重渲染保留undo/redo，换ID清空 | 常驻CPU层，不是GPU验证 |
| 11 organization selection | 实际清空；既有未恢复域 | 豁免/未恢复 |
| 12 panel/tool UI | 不入场景协议 | 既有豁免 |
| 13 data binding runtime cache | 实际清空重建；不恢复缓存 | 既有豁免 |
| 14 interactions/bindings/selectionSets/rootLayerOrder | capture→实际规范化setter及目录载体 | 未据此升级 |
| 15 metadata/thumbnail/simulationEntities | captured全量对象经setActiveScene接管 | 未据此升级 |
| 16 dashboard/engineering analysis | 非默认合法输入capture→实际规范化消费 | 未据此升级 |
| 17 scene name/project | 名称trim、场景/项目身份与ready代际 | 未据此升级 |
| 18 Deep display state | P2释放Deep，会话显示态按既有策略处理 | 既有豁免 |
| 19 Play active | Play×Recovery未裁决 | 不升格 |
| 20 behavior graph draft | 实际useAppState同挂载重渲染保留draft和renderer snapshot refs | 常驻CPU层，不是GPU验证 |
| 21 Native UI | 本轮Web测试不适用 | Native仅既有view/selection/package证据 |

15个域有CPU正向或常驻生命周期检查；6个维持明确豁免/未恢复/未裁决。21项全列出不等于21项GPU全绿。

## 验证与冻结

证据 `test-output/j3-e-editor-domains-full-20261001/` 为本地ignored：

| 验证 | 结果 |
|---|---|
| 正式原行为baseline（before-final.txt） | 19项，6失败/13通过：动画setter5例与旧格式导入1例实际失败 |
| 最小内存升级稿 | 19/19；不回退生产源采集baseline |
| 正式升级后15文件回归（final-regression.txt） | 114/114，exit0 |
| 完整Web类型（final-web-tsc.txt） | exit0 |
| 引擎source-size（source-size.txt） | 2925文件、175既有警告、0失败，exit0 |
| production diff-check | exit0 |

新生命周期回归：模型pending期间capture不可用；旧controller加载晚到不发布/不完成新代际；仅引擎代际变更也拒旧完成；loader resolve而实际模型缺失时失败。上一刀实际runtime effect重试和新snapshot所有权检查保留。

8个本轮正式文件SHA-256见同目录frozen-source-hashes.json。已冻结全部app生产源和测试；root串行更新广域source identity收据。Native/engine/contracts未修改，未跑GPU/Cargo、未commit/push。

## 完整Gate E剩余

当前实际destroyed窗口/产品回退与首帧证据已有；本轮CPU没有触发device.lost或采集Presented。剩余包括P1 unknown自动完整宿主替换矩阵、未知驱动故障（所有合成注入仍actualDriverFault=false）、全域GPU附件/作者帧恢复、恢复前后完整Windows驱动计数/标定泄漏预算、上传量与≥5成对轮cpu-submit/gpu-timestamp/present/frame-interval渠道。

现机可由root串行：已有真实窗口destroyed入口、Chrome产品fallback、Windows进程树驱动counter、支持timestamp-query渠道。Native host monotonic恢复时间不得写成GPU timestamp；所有权资源字节不得写成驱动显存。真实unknown故障尚无合法输入来源，合成unknown可以验证声明策略但不认证驱动故障。
