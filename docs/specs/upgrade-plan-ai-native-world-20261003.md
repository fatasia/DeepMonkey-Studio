# 升级方案：AI 原生可编程三维世界 × AI4S/世界模型承接层（2026-10-03）

> 用户已确认按本方案执行：阶段 0 → 阶段 1，后续阶段逐批确认。
> 长期约束（用户 2026-10-03）：极致性能、优秀效果，对标 Unity / UE / Babylon / 西门子 PS·PD·Plant；
> 必须保证代码质量、引擎包体积、three 与 Deep（WebGPU/WASM/Native）视觉一致；编辑器性能与用户体验/交互优先。
> 子智能体统一使用 claude-sonnet-5.5。

## 1. 现状核查（2026-10-03，只读审计 + 代码抽验）

### 1.1 底层引擎 → 上层接入

| 状态 | 能力 | 证据 |
|---|---|---|
| 已接入 | WebGPU PBR、后端切换/回退、LOD/渲染包编译、HLOD（opt-in） | `apps/web/src/hooks/useAppRuntimeEffects.ts:391,493,558-704`；`apps/web/src/delivery/compileSceneRenderPacket.ts` |
| 未接入（零生产消费） | 路径追踪产品会话、资产再导入协调器、陈旧修订检测、FixedStepClock、毛发、粒子曲线/预算/PbrParticlePass、体积雾、碰撞体来源、动画混合器/Morph | `packages/deep-engine/src/index.ts:128-150,188-190`；`physics/fixedStepDriver.ts:13-75`；`particles/index.ts:6-12`；`fog/index.ts` |
| 部分 | SSR/AO 仅默认值配置（SSR 默认关）、GI/探针与阴影经抽象层间接使用 | `apps/web/src/appDefaults.ts:57-80` |

待核实：编辑器后端偏好缺省回落 `webgl`（`useAppLifecycleEffects.ts:222-224`），与交接文档"WebGPU 可用即 Deep"表述不一致。

### 1.2 three ↔ Deep 视觉不一致根因

| 项 | three | Deep | 一致 |
|---|---|---|---|
| 色调映射 | ACESFilmic（`viewerEngineCore.ts:423`） | 默认 `deep-aces`；`three-aces-r185` 需显式开启（`displayColor.wgsl:10-26,44-45`） | 否 |
| 曝光 | 1.05，动态 0.55–1.55 | 探针 1.0 | 否 |
| IBL | RoomEnvironment+PMREM | 基准场景 `environment:false` | 否 |
| 阴影 | PCFShadowMap（非 Soft） | 未见等价过滤参数 | 未证 |
| AA | SMAA+GTAO | 探针 AA 全关 | 否 |
| 材质 | Physical 含 sheen/iridescence/厚度透射 | 缺 sheen/iridescence；透射简化；glTF clearcoat 被桥拒绝 | 否 |
| 门禁 | — | 仅 0.92 感知分（`lab/benchmarkImage.ts:14-16`），无严格像素门 | 缺 |

### 1.3 AI4S / 世界模型定位差距

已有：MCP（`apps/api/src/mcpCapabilityAdapter.ts`）、工具网关 20 精选工具带 schema/审批/审计、场景命令 IR 19 类（`packages/scene-sdk/src/protocol.ts:48-72`）、固定步长行为调度、证据门与实验档案链、带种子的离线路径追踪。

缺失：`reset(seed)/step(action)/observe()` 世界接口、确定性物理快照/恢复、传感器（内参/深度/法线/分割/激光雷达）、批量无头 rollout、合成数据与标注导出、域随机化、OpenUSD、VTK/HDF5/netCDF 与体渲染、3DGS。

### 1.4 交接文档（handoff-remaining-tasks-20261004.md）判断

- 58/61 可信；剩余 3 行均卡 OrayIdd 虚拟显卡（用户级禁用一次即可解锁）。
- 风险：约 804 项未提交改动，多会话共享工作树——建议尽快打检查点提交。
- 流程负担过重（账本 106 条追加 + 61 行表 + 多份 scope-lock），近期提交集中在长尾 GPU 一致性细节，需按产品价值重排。
- §四 #3 默认本体样例停在"写注入代码"——已由本会话接手。

## 2. 战略判断

前沿模型已能直接写 three/WebGPU 代码与搭场景，"AI 写 3D 代码"会被模型本身拉平；Unity/Cocos 走"编辑器内嵌 AI"。
我们的护城河是**模型调用的世界运行时**：确定可验证的世界（IR+物理+传感器+快照）、工业语义与真实数据（BIM/CAD X_T/JT、本体、OPC UA）、证据与溯源、渲染→观测→模型自检闭环。

## 3. 分阶段计划

### 阶段 0（本周）止血
1. 检查点提交（待用户指令）；用户禁用 OrayIdd。
2. AI 助手简化（本会话已执行，见 §4）。
3. 默认本体样例场景注入。

### 阶段 1（1–2 周）同一套画面 + 接入 + 极致性能
1. 统一显示合约：three/WebGPU/WASM/Native 共用一份预设（`three-aces-r185`、曝光、同一 PMREM、阴影过滤与 bias、AA、bloom）。
2. three↔Deep 像素门：5 个标准场景，RMSE/ΔE + 感知分 ≥0.95，进 CI。
3. 材质补齐：sheen、iridescence、透射厚度/衰减、glTF clearcoat。
4. 接入：路径追踪"高质量出图"、T20 粒子消费族、T14 根运动、T12 再导入/陈旧提示、体积雾、FixedStepClock 接宿主帧循环。
5. 性能：B2/T11 帧时批（P95/P99）、ts.worker 双份 6.6M 消除、首屏预算复核。

### 阶段 2（2–4 周）AI 原生
1. World API v1（contracts 先行）：WorldState/Action/Observation schema；`reset(seed)`、`step(action, dt)`、`observe(sensors)`、`snapshot`/`restore`；Rapier 固定步长确定性；MCP + HTTP + JS/TS SDK 三路暴露。
2. 助手"计划→执行→验证"闭环：生成场景 IR/行为脚本 → Play 沙箱运行 → 截图/观测回喂模型自检 → 差异预览 + 撤销。
3. 模型路由（规划/编码用前沿模型，意图路由用小模型）、prompt 缓存、上下文从 80k 字符下压。

### 阶段 3（1–2 月）AI4S / 世界模型承接
传感器与 GT 通道、复用 cloud-render-worker 的批量 rollout、数据集导出（COCO/Parquet + manifest + 档案溯源）、域随机化、OpenUSD（开源实现，本地离线）、VTK/HDF5/netCDF + WGSL 体渲染、3DGS 渲染。

### 降级/暂停
不与通用游戏引擎正面竞争；冻结长尾 GPU 一致性研究（J3 归因、半精度位类）让位阶段 1/2；治理文档收敛为一张主表 + 交接文档。

## 4. AI 助手简化（阶段 0 已执行）

- 头部：标题下方会话下拉（分页并入"更多会话…"选项）+ 新会话图标；右侧"对话/执行任务"文字分段按钮 + 关闭。原 7 个纯图标页签整行移除。
- 正文：上下文/记忆/实验档案合并为"本次上下文"一条折叠行；能力目录统一为一条折叠行（空态与对话中同入口，展开才挂载）；空态 = 标题 + 即点即问建议，移除重复"一键运行样例"。
- 输入框：范围下拉与紧凑模型下拉收进框内工具栏；思考档位仅在模型支持时出现；说明文案收入 title。
- 执行任务页：标题块仅脚本工作区显示；记忆/档案/历史运行合并一条折叠行；目标输入复用输入框样式，框内"执行方式（只出计划/逐次确认/自主执行）+ 模型 + 运行"；示例仅在目标为空时显示。
- 令牌：面板相关硬编码金色改为 `--accent`/`--on-accent`/`--accent-soft` 派生；清理失效样式（旧 nav 行、`.ai-notice-plan`、`industrial-agent-start-actions`、`industrial-agent-mode-group`）。
- 文件：`AiAssistantPanel.tsx`、`AiAssistantComposer.tsx`、`AiAssistantSessionControls.tsx/.css`、`AssistantModelControls.tsx`、`AiContextDisclosure.tsx`、`IndustrialAgentWorkspace.tsx/.css`、`AiAssistantReliability.css`、`AiHarnessCards.css`、`styles/platform-pages.css`、`styles/assistant-model-controls.css`、`scripts/gate-agent-scope.mjs`（选择器同步）及对应测试。

## 5. 范围决策（用户 2026-10-03）

- **不做 Python SDK 与 Python 客户端/Gymnasium 适配**；World API 仅提供 MCP、HTTP、JS/TS SDK。
- 阶段 0–3 全部条目列入后续任务，按序执行不中断；OrayIdd 虚拟显卡已由用户禁用，GPU 真机验证解锁。
- 允许本地 git commit（检查点），禁止 push。

