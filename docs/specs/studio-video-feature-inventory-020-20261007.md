# 0.2.0 视频新增功能库存

系统介绍按Astra180秒方案完整重构，功能视频保留既有覆盖并替换七章。库存来自 2026-09-26 至 2026-10-07 的 git log、当前消费方与验收文档；工程探针和实际编辑操作分别记录。

## 现状核查

1. 已检查全仓任务关键词和当前未跟踪文件；两部历史片分别为 9/25 系统介绍和 9/26 全功能实录。
2. 已读本体行动、图谱、场景发布与工业格式合同。复用现有能力词汇和冻结包。
3. React Flow、现有行为运行时、FFmpeg、SDK 模板已在用，无新增图谱或录屏框架。
4. 找到编辑器面板、API 路由、Agent 运行历史、SDK gate 和 SceneViewer 的真实消费链。
5. 核对组件测试、模板门和 H-C4/C5/C6/C7 报告；旧报告只能证明对应切片，最终视频另查当前构建。
6. 已读近期规格、交接和工业格式权威计划。README 不改。

**已有（不重建）**：旧片的场景编辑、2D、工业分析、AI Harness 与发布章节；现有 SDK、行为运行时与离线发布链。

**真实缺口**：旧片未包含下列近期工具、新的本体/Agent 交互以及本轮自由图编辑。需要当前 UI 镜头和更新旁白，不能只给历史视频换文件名。

## 新片内容与可用证据

| 内容 | 当前能力与来源 | 视频表达与镜头 |
|---|---|---|
| 数据处理与本体图谱 | DataPipelinePanel、OntologyGraphView；独立SMT演示流程60→20→18→18；方向/基数/字段映射 | 已录节点移动/保存/运行与本体端口拉线/配置/新草稿保存；自由改接需另拍 |
| 时间线与相机巡检 | `61d33931`；SceneTimelinePanel、SceneTimelineDirectorControls、相机录制测试 | 关键帧和相机路径；新增创作工具段，当前镜头待录 |
| 预制体与工业材质 | `82fe4214`、`21c14177`；userPrefabActions、userPrefabModel.test、12 个 industrialMaterialPresets | 重复组件与物理材质选择；不把全部工业预制件说成完整 CAD |
| 材质图、VFX 图与烘焙 | `ebcc874c`、`444197bc`、`6f1f62a6`；MaterialGraphEditor、LightingBakeBenchPanel | 轻量材质图、效果模板与烘焙状态；不称为任意 Shader Graph 等价物 |
| 物理调试与碰撞体 | `25e32040`、`1d9a1140`、`bd6cc5c7`；PhysicsDebugTimeline 与碰撞体编辑 | 碰撞体可视编辑、录制/回放；只引用已接编辑器功能 |
| 本体行动与 Agent | 行动定义/身份映射/预览服务、IndustrialAgentWorkspace、agentRunHistory；本轮桌面回调与身份/参数输入、单任务3/5分钟预算 | Agent第四run96.488秒完成，12秒真实结果查看已准入；SMT行动参数预览仍待实录 |
| 行为脚本热插 | H-C6-S1 UI 接线及多模块隔离报告，SceneBehaviorHost→Manager→session→面板 | 运行中替换行为、失败回滚；不宣称跨会话持久热插 |
| SDK 与 MCP | H-C7-P2 八模板、H-C7-P1 API 闭环；当前 SDK 发布文档 | 离线 tgz、八模板、版本化契约；文档镜头明确为接入说明，消费者运行由门验证 |
| 离线工业格式 | `industrial-3d-format-work-plan-2026-09-16.md` 与导入 capability/profile | 内置离线导入和 profile 状态；JT/X_T/RVT/SolidWorks 各有具体范围，未知/不完整 profile 保持 inspect/preview，禁止笼统宣称全格式完整解析 |
| 三引擎与交付 | 当前实际同场景 WebGL/Deep/WASM、贴图验证、冻结资源 SHA、只读裁剪 | 当前镜头；RT/LOD GPU 探针注明验证场景；静态 Pages、Windows 客户端最终产物分别验收 |

## 待补录

创作工具段优先录时间线、材质预设/图和预制体；Agent 段优先录运行历史、本体行动预览。若某项仅有版本说明镜头，明确说明其为功能说明，不把静态文档剪成执行演示。

最终渲染等待三引擎卡顿根因修复与当前 WASM 镜头；新输出使用 0.2.0 独立目录。CPU libx264 固定两线程，附完整字幕、章节、来源和 SHA-256。

具体连续镜头与控件见[SMT录制工单](../assets/studio-020/intro-astra-smt-capture.md)，系统片制作状态见[Astra准备](../assets/studio-020/intro-astra-production-prep.md)，长片七章替换与原速合成见[功能片准备](../assets/studio-020/features-refresh-prep.md)。当前系统片87/180秒已准入，完整新片未导出；长片剪辑规划468.633秒，缺9镜。已发布v2行动预览与当前成功Agent结果进入两片，Three产线开场/模型根选择28秒只计系统片。旧片仅保留备份，不作为新版本完成证据。
