# 编辑器能力深度调研(2026-10-03,只读盘点)

> 结论先行:编辑器现有 **24 个功能域,绝大多数完整可用**,底座(命令/事务、面板系统、播放/编辑双模式、发布管线分离、AI 共用写通道)达到行业主流架构水准;真实缺口是 **14 项**,其中 5 项 P0(高频生态缺口)、5 项 P1(差异化)、4 项 P2。编辑器整体不是"从零补",而是"精准补 14 项 + 把协同雏形升级"。

## 一、功能域 × 成熟度矩阵(24 域)

| # | 功能域 | 代表文件:行数 | 成熟度 |
|---|---|---|---|
| 1 | 场景对象编辑(创建/变换/多选/层级) | AppStudioViewport:776、SceneOutlinerPanel:200、SceneMultiTransformEditor | 完整(事务+测试密集) |
| 2 | 图层/组织/拖拽 | SceneOrganizationPanel:299、layerKeyboard | 完整 |
| 3 | Prefab/工业资产库 | prefabs/industrialPrefabCatalog(10+ 分类:传送/机器人/管路/道路参数化) | 完整(目录式,非嵌套编辑) |
| 4 | 资产导入/优化/工程化 | ModelOptimizer:352、ModelDiffReviewPanel、RvtImportSettings | 基础~完整(无交互式 LOD 编辑) |
| 5 | 材质与外观(含高级 lobe) | MaterialAdvancedLobes、MaterialTextureSettings | 完整 |
| 6 | 灯光/环境/后期 | SceneIesEditor:70、SceneEnvironmentPanel:303、SceneProbeGridBakePanel:124、ScenePostProcessingEditor:343 | 完整(无 lightmap UV 烘焙) |
| 7 | 物理 | ScenePhysicsPanel:414、PhysicsDebugPanel | 基础(无 collider 形状可视编辑) |
| 8 | 动画/时间线 | SceneTimelinePanel:559(多轨/拖帧/导演台/仿真轨)、ModelAnimationControl:219、SceneAnimationStateMachineEditor:70 | 基础~完整(缓动仅 smooth 预设;无嵌套序列) |
| 9 | 相机/导演/漫游 | CameraNavigationPanel:430(Shots 书签、三人称巡检人物、防穿模) | 完整 |
| 10 | 行为/交互/脚本 | BehaviorGraphEditor:645、InteractionEditor:558、restrictedEvaluator 沙箱、ScriptVersionManager:380 | 完整(行为图+交互触发器+脚本三层) |
| 11 | 数据绑定/IoT/写回 | SceneDataBindingEditor:499、DataReplayPanel:96 | 完整 |
| 12 | 二维大屏自由画布 | DashboardWorkspace:770、Canvas:398、60+ 组件库、30+ 模板文件 | 完整(**第二主角**) |
| 13 | 数据中台/管道/拓扑/本体 | DataPipelineStudio:415、TopologyEditorPanel:500、OntologyWorkspace:694 | 基础~完整 |
| 14 | 工业仿真/排产/虚拟调试 | PlantLite 全家桶(30+ 文件、遗传算法实验)、PprPlanEditor、VirtualCommissioningWorkbench:548 | 完整(**差异化重心**) |
| 15 | 机器人/工作单元 | RobotAssetWorkspace:84、RobotWorkcellPathEditor、RosbridgeConnection | 基础~完整 |
| 16 | 视觉 AI/行业包 | VisionCenterWorkspace:684、Battery×12、industryPack | 基础~完整 |
| 17 | 参数化建模 | ParametricModelWorkbench + CAD worker(CAD→GLB) | 基础 |
| 18 | 发布/交付 | ScenePublicationDialog:217(访客权限)、delivery/ 10k、发布版本恢复 | 完整 |
| 19 | 播放模式/回放 | useScenePlayMode、playTraceStore | 完整 |
| 20 | AI 助手 | ai/ 3.9k + 45 组件(草稿审阅/证据/溯源/预算) | 完整(**AI-first**) |
| 21 | 测量/标注/剖切/爆炸/钻取/XR | SceneClippingPanel:173、SceneDrillWizard:101、SceneXrPanel:202 | 完整 |
| 22 | 诊断/性能 | RendererDiagnosticsPanel、QualityTelemetryPanel、崩溃恢复 | 完整(缺作者级 Profiler 泳道) |
| 23 | 文档/账号/白标 | DocsCenter:281、BrandingSettingsPage | 基础 |
| 24 | 音频 | SpatialAudioEditor:103、alertAudioDirector | 基础(无混音器) |

## 二、底座架构评估(对比行业主流编辑器)

| 底座 | 现状 | 评级 |
|---|---|---|
| 命令/事务 | commandBus + SceneGraphTransactionDriver + 引擎为事实来源,AI 与人共用写通道 | 主流水准 |
| 撤销/重做 | 快照式 history + 发布版本恢复 + ModelDiff | 主流(缺分支式 diff 浏览器) |
| 协同 | **单编辑者租约+心跳+服务端写事务轮询**(useEditorPresence)——多端写架构已预留,UI 未开放 | 雏形,升共编的底座在 |
| 面板系统 | 拖拽悬浮面板+工具坞五分类+多页检查器 | 主流 |
| 播放/编辑双模式 | Play 禁编辑、退出恢复、受限沙箱 | 主流 |
| 发布管线分离 | delivery/ 编译器(看板栅格化/XR 包/cluster LOD) | 超出多数 Web 编辑器 |

## 三、确认缺失的 14 项与补齐方案

### P0(高频生态缺口,第一批)
| 缺口 | 方案 | 验收门 |
|---|---|---|
| Shader/材质节点图 UI | CustomShaderEditor(68 行表单)升级为节点画布,**复用行为图 G2 画布底座**+T08 求值器;节点:纹理/数学/lobe/输出;实时预览球;变体 fail-closed 提示定位到节点 | 20 节点图预览 ≤1 帧 |
| 贝塞尔缓动曲线编辑 | 时间线关键帧现仅 smooth 预设;复用 T20 曲线编辑组件做逐属性缓动曲线 | 任意轨关键帧缓动可编辑并即时预览 |
| Collider 形状可视编辑 | 场景内绘制盒/球/凸包手柄(ScenePhysicsPanel 扩展+T17 合同),改完即时生效 | 改 collider ≤1 帧生效 |
| 快捷键自定义 | 硬编码键位(hardcoded KeyboardEvent)收敛为键位表+设置 UI | 全部工具坞动作可映射 |
| 音频混音器 | SpatialAudioEditor 之上加多轨混音(轨=音源,推子/总线/告警路由) | 8 音源混音实时预览 |

### P1(差异化,第二批)
| 缺口 | 方案 | 验收门 |
|---|---|---|
| 多人共编+评论审阅 | useEditorPresence 租约升级:**对象级锁**(写事务已按对象走 port)+ 评论锚点(对象/相机位);服务端写事务轮询通道已有,先做"锁+审阅"不做 CRDT | 双人同场景,冲突对象自动拒绝并提示 |
| 分支式版本 diff 浏览器 | 场景 JSON 快照 diff(复用 scenePublicationDiff)+ 树形差异浏览器+按对象回滚 | 万对象场景 diff ≤2s |
| 贴花投影 | 计算着色器投影贴花 pass(Deep 已有实例描边同类管线经验) | 1000 贴花单 pass |
| 植被/散布笔刷 | 沿地形/表面散布实例(走 T26 代理/批处理管线) | 1 万散布实例 60fps |
| 地形雕刻笔刷 | 高度图抬升/平滑/压平(基础地形 T13 已有接缝零裂缝) | 4096² 实时笔刷 |

### P2(第三批)
交互式 LOD 编辑(manifest+发布管线已有,补 UI)、lightmap UV 烘焙(探针烘焙已有,补面烘焙)、导航网格编辑(漫游已有,补可编辑 navmesh)、多语言资源文件化(现 tr() 内联双语)。

## 四、与 UE-class 方案的合并

[ue-class-leap-plan-20261003.md](ue-class-leap-plan-20261003.md) §7 修订:
- 编辑器第一批 = **Profiler 泳道面板**(逐 pass GPU 计时已在引擎)+ **P0 五项**(节点图/曲线/collider/快捷键/混音器——全部复用底座,无unknown风险)
- 第二批 = P1 五项(协同与贴花/植被与 §1-6 渲染专项共享 pass 基建)
- 第三批 = P2 四项
- 时间线编辑器从"新建"改为"增量"(轨道类型扩展+缓动曲线+嵌套序列)
