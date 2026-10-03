# H-C6-S3-inventory:全量能力入口对账矩阵 v1(2026-10-02,主线程)

> 估时表 H-C6-S3-inventory:"全量编辑器/API/运营中心能力入口对账,按业务路径产出接入矩阵"(2-4h,高信心)。本文件=域级 v1;逐入口细化(每 Panel/每端点)为 v2 余量。

## 规模底数(grep 实证)

- 组件 403 个(非 test .tsx),其中 Panel 形态约 60+;
- API clients **21 个模块**(apps/web/src/apiClients/),`request<T>` 端点引用 **147 处**;
- 命令式路由(appRoute/openBrowseRoute,非声明式);工作区 10 个(lazy 路由级):Studio 主编辑器(applications/pages/scenes)、DashboardWorkspace、SceneManager、TopologyEditorPanel、ModelOptimizer、DataCenter、SystemCenter、BrandingSettingsPage、VisionCenter、OperationsCenter(含 task=commissioning/whatif 参数);另有 /view、/published 发布链。

## 域级接入矩阵(业务路径 × 入口形态 × 状态)

| 业务域 | 入口(工作区/面板) | API client | 状态 |
|---|---|---|---|
| 场景编辑 | Studio(viewer+sceneEditor bindings) | modelSceneApi/modelStructureApi | 接通(生产) |
| 仪表盘 | DashboardWorkspace+DashboardCanvasNode | dashboardPublicationApi | 接通(生产) |
| 场景/模型管理 | SceneManager | modelSceneApi+assetLibraryApi | 接通(生产) |
| 拓扑编辑 | TopologyEditorPanel | ontologyApi+semanticModelApi | 接通(生产) |
| 模型优化 | ModelOptimizer | modeling3dApi | 接通(生产) |
| 数据中心 | DataCenter | dataWritebackApi+industrialApi | 接通(生产) |
| 系统中心 | SystemCenter+BrandingSettingsPage | authenticationRecheck+branding(内联) | 接通(生产) |
| 视觉中心 | VisionCenter | visionApi | 接通(生产) |
| 运营中心 | OperationsCenter(task=commissioning/whatif) | pprBopApi+industrialAgentApi | 接通(生产) |
| 告警 | AlertIngestPanel | alertIngestApi | 接通(生产) |
| 电池智能 | BatteryIntelligence* 三面板 | (battery 域内联) | 接通(生产) |
| AI 助手/记忆/溯源 | AiAssistantPanel+AiMemoryPanel+AiProvenancePanel | aiApi+assistantStream+mcpApi+provenanceApi | 接通(生产) |
| 发布/浏览 | /published+/view+publishedApplicationApi | publishedApplicationApi+scenePublicationDependencyApi | 接通(生产) |
| 行为/物理 overlay | AppBehaviorOverlay+SceneBehaviorHost(scripting 域) | —(引擎内) | 接通(生产;热插第一刀 20261002) |
| 路径追踪 | PathTraceAuthorDialog | (I-C16 产品链) | 接通(生产) |
| 质量遥测 | QualityTelemetryPanel | —(引擎 manifest) | 接通(生产) |
| 外部资源 | DashboardInspectorData→DashboardWidgetVisualization:386(GeoJSON 地图)+ParametricModelWorkbench:117(模型下载) | externalResourceApi | **接通(生产;20261002 connect 首批修 3 缺陷+浏览器验证)** |
| 脚本 Git | SceneBehaviorPanel:435→ScriptVersionManager(七端点全消费,入口=行为面板「更多工具→脚本版本」) | scriptGitTypes+api scriptGit 族 | **接通(生产;20261002 浏览器全链验证)** |
| PPR/BOP | —(pprBopApi 消费方在 OperationsCenter 域) | pprBopApi | 接通(生产,归运营中心) |

## 结论与余量（2026-10-02 connect 首批后回写）

- **域级对账:18 业务域全部接通**(原 2 个"部分"经 connect 首批核查:scriptGit 为 inventory grep 大小写漏检——UI 早已存在;externalResource 入口在但消费面有断根级缺陷,已修复+浏览器证据 failures=0)。修订依据:hc6s3-connect-batch1-20261002.md §1。
- v2 余量(下批):①403 组件逐个能力标签(工作区内面板级);②147 端点逐条对账到 UI 消费点;③"/operations" 子任务全参数面;④inventory grep 教训沉淀:类型名大小写变体(scriptGit vs ScriptGit*)必须多形态匹配。
- 本 inventory 服务 H-C6-S3-connect(补首批确定缺失入口)的输入:v2 细化后再重估 connect 批量。
