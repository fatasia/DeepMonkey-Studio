# README 功能核查与改写记录（2026-10-03）

目的：把 `README.md` / `README.en.md` 的"功能亮点"和"完整功能列表"写完整、写准确。原则是先核查代码与文档，再动笔；只写已落地并有依据的能力。

## 1. 现状核查（六步）

1. **全仓 grep**：对 `apps/web/src`、`apps/api/src`、`packages/*/src` 检索 AI 助手、示例场景、显示合约、陈旧修订、根运动、粒子、体积雾、固定步长、路径追踪、本体、DeepSL、设备布局、钻取、版本对比等关键词；未跟踪文件（`git status --short | grep '^??'`）已一并看过。
2. **契约层**：`packages/contracts/src/{data,dashboard,scene,ontology,displayContract}.ts`、`packages/scene-sdk/src/{protocol,sceneCommandTransaction,behaviorScheduler}.ts`。
3. **依赖**：根与各包 `package.json`（React 19、Vite 8、three 0.185.1、Monaco 0.57、Fastify 5、Tauri 2、pnpm 11.18.0、Node ≥24；`deep-engine` 的 `exports` 子路径）。
4. **消费方**：逐项确认编辑器里有真实入口（组件被 `<X />` 引用），不是只有合同或引擎模块。
5. **测试与证据**：`docs/specs/` 近期文档的验证小节、`scripts/gate-parity.mjs`、`test-output` 引用。
6. **规格文档**：`docs/capabilities.md`、`docs/converter-plugin-and-format-support.md`、`docs/specs/` 近期十余份、`CHANGELOG.md`、`ROADMAP.md`、`apps/web/src/docs/*.md`。

**已有（不重建）**：旧 README 的 14 组功能表述大体可信，组结构、术语和顺序保留。

**真实缺口**：近期落地的能力没写（AI 助手新交互、示例场景、显示合约与对拍门、资源陈旧检测、根运动、粒子曲线与预算、体积雾反照率、固定步长、路径追踪出图、Monaco worker 瘦身）；还有一批早已存在但从未写进 README 的能力（本体包、设备与测点智能绑定、批量设备布局、钻取向导、模型版本对比、DeepSL、模型屏幕、骨骼 IK、事件持久录制、AI 3D 生成、更多数据源类型）；以及几处不准确的描述（见 §3）。

## 2. 核查表

状态：**准确** = 旧文无误，保留；**修正** = 旧文不准或过期，已改；**新增** = 已实现但旧文没写，已补；**未写入** = 在建或未验证，按要求不进功能列表。

### 2.1 近期落地能力

| 功能点 | 依据 | 状态 |
| --- | --- | --- |
| AI 助手 对话/执行任务 双模式、标题栏会话下拉 | `apps/web/src/components/AiAssistantPanel.tsx`（`role="tablist"`、`AiAssistantSessionPicker`）、`checkpoint 001` | 新增 |
| "提问范围"下拉（编辑器：场景/对象/BIM/仿真运营/看板/问数据；平台：全平台/二维） | `apps/web/src/ai/assistantModeTabs.ts` | 新增 |
| "本次上下文"折叠区（来源就绪度、记忆、实验档案） | `AiAssistantPanel.tsx` `ai-context-group` | 新增 |
| 执行方式 只出计划/逐次确认/自主执行；审批指纹 15 分钟；计划档拒绝写/仿真/控制 | `IndustrialAgentWorkspace.tsx:375-407`、`docs/specs/h-autonomy-configurable-20261003.md` | 新增 |
| Tool Harness 默认 20 个精选工具、无 shell/文件/任意命令 | `apps/api/src/ai/industrialAgentToolGateway.ts` `CURATED_TOOL_IDS` | 修正（旧文写成还能"截图检查、触发发布验证"） |
| 场景命令事务：≤64 条、差异计划、修订冲突拒绝、回滚 | `packages/scene-sdk/src/sceneCommandTransaction.ts`、`apps/api/src/mcpEditorSceneTransactionBridge.ts` | 修正 |
| 新建场景默认示例本体（底座/立柱/行为热点 + 概览视角），可选空白 | `controllers/defaultSceneSample.ts`、`sceneCreationAction.ts`、`docs/specs/default-scene-sample-20261003.md` | 新增 |
| `DEFAULT_DISPLAY_CONTRACT`（three-aces-r185、曝光 1.05、动态曝光 0.55–1.55、阴影 2048/bias、GI 0.32） | `packages/contracts/src/displayContract.ts`、`viewer/displayContractThree.ts`、`displayContractParity.test.ts`、`docs/specs/display-contract-unification-20261003.md` | 新增 |
| `pnpm gate:parity`：5 标准 + 3 诊断场景；PBR 矩阵/方向光阴影严格档，IBL 容许档，AA+Bloom/透明为已知差异；仅真实 GPU，无适配器即失败；单机标定；未接 CI | `scripts/gate-parity.mjs`、`docs/specs/parity-gate-20261003.md`；`.github/workflows` 无 parity 引用 | 新增（如实写明局限） |
| 资源陈旧检测、一键更新/保持当前、删除影响面（字段路径级） | `components/ProjectAssetInventory.tsx` `AssetRevisionInlineNotice`、`delivery/assetRevisionUpdate.ts`、`assetDeletionImpact.ts`、`docs/specs/t12-asset-revision-wiring-20261003.md` | 新增（遗留项已写成边界：无旧修订取包端点、"保持当前"仅会话内） |
| 模型根运动（平移+旋转）、开关、复位、会话态 | `viewer/viewerEngineRootMotion.ts`、`ModelAnimationControl.tsx`、`docs/specs/t14-root-motion-rotation-ui-20261003.md` | 新增（保存前需复位的遗留已写明） |
| 粒子曲线（尺寸/透明度/热度色）、预算 1024、透明排序 | `viewer/modelFireParticles.ts`、`ParticleCurveEditor.tsx`、`contracts/scene.ts` `SceneFireEffectState`、`docs/specs/t20-particle-consumption-20261003.md` | 新增（GPU 路径与 WebGPU 逐粒子尺寸为已知边界） |
| 体积雾 + 散射反照率（0–1，默认 0.82）；体积光；SSR | `contracts/scene.ts` `ScenePostProcessingState`、`ScenePostProcessingEditor.tsx`、`docs/specs/fog-fixedstep-wiring-20261003.md` | 新增；"Deep WebGPU 专有"是合同注释所述 |
| 物理固定步长 `FixedStepClock` 60 Hz、追赶上限 12、确定性单测 | `viewer/physicsWorldHost.ts`、`deep-engine/src/physics/fixedStepDriver.ts`、同上文档 | 新增（无渲染插值、行为与物理两条时钟为已知边界） |
| 路径追踪出图：CPU 参考、三种照明、2% 噪声门、线性 HDR + 回执 | `components/PathTraceAuthorDialog.tsx`、`delivery/pathTraceAuthorSession.ts`（已入 `e59ce4df`） | 新增 |
| Monaco 单份 ts.worker，总资产 75,704,041 → 66,106,866 B | `docs/specs/bundle-tsworker-dedup-20261003.md`（实测段） | 新增 |

### 2.2 早已存在、旧文未写

| 功能点 | 依据 | 状态 |
| --- | --- | --- |
| 本体包（对象/关系/动作/事件类型，草稿→评审→发布→退役，回滚，未确认属性阻止发布，动作风险分级，关系图） | `contracts/ontology.ts`、`apps/api/src/ontology/ontologyRoutes.ts`、`components/OntologyWorkspace.tsx`（由 `SemanticModelStudio` 挂载） | 新增 |
| 设备与测点智能绑定 | `SmartAssetBindingWorkbench.tsx`（`SceneOutlinerPanel` 引用） | 新增 |
| 批量设备布局（阵列/GeoJSON/DXF 对齐/标签） | `DeviceLayoutWorkbench.tsx`、`docs/device-geojson-layout-and-labels.md` | 新增 |
| 空间钻取向导 | `SceneDrillWizard.tsx`（`AppWorkspaceTopbar` 引用） | 新增 |
| 模型版本对比评审 | `ModelDiffReviewPanel.tsx`（`AppStudioShellView` 引用） | 新增 |
| DeepSL 自定义着色器、模型屏幕、骨骼与 IK | `CustomShaderEditor.tsx`、`ModelScreenEditor.tsx`、`ModelRigControl.tsx`（均由 `ObjectAppearanceEditor`/`AppStudioInspector` 引用） | 新增 |
| 对象效果七项（轮廓/发光/X 光/扫描线/热力/溶解/边缘光） | `contracts/scene.ts` | 新增 |
| 事件持久录制（运营中心） | `EventRecordingPanel.tsx`（`OperationsCenter` 引用） | 新增 |
| AI 3D 生成（Tripo3D / 腾讯混元 3D） | `apps/api/src/ai/modeling3dRoutes.ts`、`parametric/Modeling3dPanel.tsx` | 新增 |
| 数据连接 32 类 | `contracts/data.ts` `DataConnectionType`，API 侧 `dataIntegration*.ts` 有对应适配 | 修正（旧文漏 MariaDB/TiDB/Doris/StarRocks/ClickHouse/Elasticsearch/InfluxDB/Prometheus/CSV/Excel/演示数据） |
| 行为脚本 `onFixedUpdate` 1/60 s、每帧 ≤5 步、溢出计数 | `scene-sdk/src/behaviorScheduler.ts` | 新增 |
| 三档构建（Deep Engine SDK / Scene Viewer / Full Studio） | `apps/web/src/docs/on-demand-packaging.md` | 新增 |
| MCP `bim-industrial-core`、`resources/*`、`editor.scene-transaction` | `apps/api/src/mcpCapabilityAdapter.ts`、`mcpEditorScene*.ts` | 修正（细化） |
| SDK 子路径 `/scene` `/hlod` `/particles` `/physics` | `packages/deep-engine/package.json` `exports` | 修正 |
| 素材包导入校验（manifest/catalog/audit + SHA-256、原子替换） | 原 README 快速开始第 5 节 | 新增（功能列表补一条） |

### 2.3 旧文与代码不符、已更正

| 旧表述 | 实际 | 处理 |
| --- | --- | --- |
| Tool Harness 可"截图检查并触发发布验证"；亮点写"验证结果并交付" | 精选工具里没有截图或发布验证；场景侧只有命令事务；"计划→执行→验证"闭环仍在规划 | 改写为实际的 20 个工具与事务写入；亮点去掉"验证并交付" |
| "Docker 一键部署（已支持）" | `docker-compose.yml` 只有 PostgreSQL + MinIO，应用本体无官方镜像（`docs/deployment.md` 同样写明） | 小节标题与首句改为"用 Docker 启动存储基础设施" |
| `.env` 最小配置里 `METADATA_STORE=sqlite` | `.env.example` 默认 `json`；`sqlite` 是推荐值 | 补一句说明，指向第 6 节 |
| SSR、体积雾与普通后处理并列 | 合同注释：SSR、体积雾、体积光是 Deep WebGPU 能力，其它端须报告不支持 | 标注后端限定 |
| 关键帧"线性/平滑/曲线插值" | `KeyframeTransition` 五种（线性/平滑/缓入/缓出/阶跃），相机轨迹另有 spline | 按实际改 |
| RVT 链路未提 Revit 依赖 | 需已授权 Revit 的转换机，文档明确"不计入 builtin-only" | 如实注明 |
| JT/X_T "已验证子集预览" | JT 9.5/10.3 LOD0 出几何、8.x 仅结构；X_T 子集→`xt-reader` 通用解析→检查态；X_B 阻断 | 细化 |
| "Modbus TCP" | 合同类型为 `modbus` | 改为 Modbus |
| 技术栈"bvh" | 实际依赖 `three-mesh-bvh` | 改名；存储行补充 ClickHouse 等 |
| 物理仅写"旋转关节" | UI 有限位与速度马达、初速度、碰撞体线框；棱柱关节与碰撞体来源（convex-hull 等）只在合同/引擎，编辑器无入口 | 补 UI 已有项，棱柱关节与碰撞体来源不写 |

### 2.4 刻意没写（在建、未验证或产品不做）

| 项 | 原因 |
| --- | --- |
| World API（reset/step/observe）、传感器、批量 rollout | 规划中，仅在 `ROADMAP.md`/升级方案口径 |
| 路径追踪多 Worker 并行与 PNG 导出 | 对话框与 `pathTraceAuthorParallel/BandHost/Png` 在工作树里在建（部分文件仍是未提交修改/未跟踪），未验证落地；README 只写已入库的单线程 CPU 参考 + HDR 回执 |
| Deep 描边、sheen/iridescence 材质 | 在建 |
| 助手"计划→执行→验证"闭环、模型路由 | 在建 |
| Python SDK/客户端 | 产品不做 |
| 数据中心"加载内置样例数据"按钮 | 代码与单测在，但按钮端到端浏览器验证尚未做（`datacenter-builtin-sample-20261004.md` 自述），暂不写 |
| AGV 实时/仿真切换 | 只有文档与 `factory-flow-plugin` 包，编辑器内没有消费入口 |
| GPU 粒子管线（`PbrParticlePass`）、粒子 GPU 排序 | 未接入编辑器，已作为边界写明 |

## 3. 保护区块 sha256（前后对比）

范围（逐字节）：`## 功能亮点`（英文 `## Highlights`）之前的全部内容（logo/标题/徽章/语言切换/作者的话/系统介绍标题/演示视频/核心功能录屏/架构图行），以及 `## 许可`（英文 `## License`）到文件末尾（许可/鸣谢/联系我）。

| 文件 | 区块 | 字节 | 改前 sha256 | 改后 sha256 | 一致 |
| --- | --- | --- | --- | --- | --- |
| README.md | 顶部至"功能亮点"前 | 2782 | `d70d1f59454348b56f0cf2e3cc14d117ab1980c36b40ec1564799438c894a9de` | `d70d1f59454348b56f0cf2e3cc14d117ab1980c36b40ec1564799438c894a9de` | 是 |
| README.md | 许可 → 文末 | 774 | `2d5bf57982ce978044a42a8dea5da6723781a3792d8fa37d476ddf9808df0f0f` | `2d5bf57982ce978044a42a8dea5da6723781a3792d8fa37d476ddf9808df0f0f` | 是 |
| README.en.md | 顶部至"Highlights"前 | 2844 | `3a07dc1ad51a4d0c05dddeba47d9987d7fc391f7a24d027fadfc9cfadf9b6237` | `3a07dc1ad51a4d0c05dddeba47d9987d7fc391f7a24d027fadfc9cfadf9b6237` | 是 |
| README.en.md | License → 文末 | 1015 | `e53c32fed391d4f7cc04d09e96815409a1d44505a669537be2dd94f692a840c6` | `e53c32fed391d4f7cc04d09e96815409a1d44505a669537be2dd94f692a840c6` | 是 |

## 4. 改动摘要

两版同步，条目一一对应（各 16 个区块，条目数逐组相同）：

- **功能亮点**：5 条重写，去掉"验证并交付"之类超出实际的说法，补上显示合约与对拍门、数据连接规模。
- **完整功能列表**：
  - 重写 AI 一组（双模式、执行方式、Tool Harness 边界、命令事务）。
  - 项目与资源新增示例场景、陈旧检测与删除影响面、AI 3D 生成、素材包校验。
  - 模型与格式按实际状态细化。
  - 3D 编辑器拆出新组"环境、效果与出图"（体积雾、粒子、后处理后端限定、路径追踪出图），编辑器内补根运动、骨骼 IK、DeepSL、模型屏幕、物理细节与固定步长。
  - 新增组"数字孪生场景搭建"。
  - 数据中心补 32 类连接与本体包；脚本组补 Monaco worker 瘦身与固定步长回调；工业组补事件录制；Deep 组补显示合约、对拍门、子路径；发布组补三档构建；扩展性组细化 MCP。
- **技术栈**：`three-mesh-bvh`、存储行、表格排版。
- **快速开始**：第 2 节补 `METADATA_STORE` 说明；第 8 节更正 Docker 描述。
- **文档**：补功能清单、部署指南、路线图、更新记录链接。
- **Deep Engine**：补显示合约与对拍门说明及链接。
- 参与贡献、命令表、环境依赖等经核查无误，未改。

## 5. 链接检查

对两份 README 中所有相对链接（含图片）逐一检查目标存在，0 缺失（脚本在会话中运行，未入库）。

## 6. 发现但不在本任务范围（保护区块内，未动）

- `README.md` 的"许可"节写"MIT 协议"，`README.en.md` 的 License 节与 `LICENSE`、`package.json` 均为 `DMCSL-1.0`；`README.en.md` 顶部"License designation"行写"MIT License + Ethical Restrictions"。提交 `e8772299` 的说明是双 README 统一回 DMCSL-1.0，现状两版不一致，需要项目负责人决定口径。
- 两版架构图文件不同（中文 `platform-architecture-business-v2.png`，英文 `platform-architecture-gold.png`），均存在。
