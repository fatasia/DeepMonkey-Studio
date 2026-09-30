# 面向 AI 的 3D 框架与 Claude/Codex 接入方案

给引擎、SDK 和 AI Harness 开发者使用：让 AI 能从需求生成可运行场景，观察真实结果，再局部修改；用户可继续写自由 JS/TS、自定义材质和插件。

状态：2026-09-30用户已要求并入后续任务，登记为H-C7-P1–P4；新增API与客户端安装包尚未实施。现行J/C主线与唯一I专线继续，本文不改开发优先级。工业导入仍遵循 `industrial-3d-format-work-plan-2026-09-16.md` 的内置、本地、离线路线。

## 现状核查

1. 源码与未跟踪：检查 packages/apps 的 SDK、MCP、scene transaction、snapshot、agent gateway 和 Shader Authoring；核对 `git status --short`，C8/J3/I 当前在途文件保留独立所有权。
2. 契约：读 `packages/scene-sdk/src/protocol.ts`、`sceneCommandTransaction.ts`、`packages/plugin-runtime/src/capability.ts`、现有 renderer capability manifest。现有 SceneCommand 可改变换/材质/相机/动画，但该联合类型没有创建几何/灯光/对象、删除与重设父级命令。
3. 依赖：scene-sdk 仅依赖 contracts；deep-engine 已有正式 app/webgpu/gltf/shader-authoring/shader-package/three-bridge 导出，Three 0.185.1 是当前开发/桥接依赖。API 使用现有 Fastify MCP adapter；不另起渲染内核或工业执行循环。
4. 消费方：`registerMcpCapabilityRoute` 已服务 `/api/mcp`，注册表生成工具；`editor.scene-transaction` 委托真实浏览器 driver，读路径包含活跃编辑器、场景与诊断资源；`IndustrialAgentToolGateway` 有独立固定工业工具目录。SDK 文档已有 DeepApp 宿主帧驱动与 PbrRenderer 实际接入。
5. 测试与证据：已有 sceneCommandTransaction、mcpEditorSceneTransactionBridge、mcpEditorSceneResources、editorSnapshotFetchBridge、agentHarnessIntegration 测试和 `gate:deep-engine-consumer` 仓外离线安装/真实 Chrome WebGPU 门。它们分别证明内部合同或独立引擎消费，不能替代 Claude/Codex 的真实协议连接与视觉调用。
6. 规格：对照本日 handoff、剩余清单、SDK 文档、工业格式权威计划与恢复台账；H-C6-S1 已明确专业自由脚本不逐条审批，C24 编辑器写路径仍后置，复用既有 Harness。本文所需工作归入对应现有任务，避免另建一套 AI 平台。

**已有（不重建）**：渲染器、统一 Shader Package、能力注册表、事务与回滚、作者对象与持久化、脚本生命周期、Harness、MCP 入口、按需 GPU readback、独立 SDK 消费门。

**真实缺口**：离开编辑器后容易生成场景的作者 API、创建/删除等写能力的完整接线、外部客户端可直接看的图像、协议兼容实测、可分发 Skill、可运行模板与迁移路径、AI 实际任务评测。

静态核查还发现一个具体接线风险：`mcpCapabilityAdapter.ts` 把 MCP `params.arguments` 结构传给 `callEditorSnapshotFetchTool`，后者却读取 `params.input`；标准工具调用可能拿不到 sessionId。此外当前快照通过文本返回 base64 原始附件，并非可直接展示的 MCP 图像。先加标准客户端形状的路由回归来确认与修正，不能把已有 readback 等同于完整视觉能力。

## 产品与架构判断

Three 的优势包含模型已经熟悉其 API、社区案例多、能立即运行。新框架的机会是缩短生成与修正过程，同时把工业场景、性能与双端能力做扎实。仅包装 MCP 或改几个类名不足以形成替代。

采用一个内核、三种入口：JS/TS SDK 给开发者，CLI 给编码代理和 CI，MCP 给运行中的编辑器与资产/诊断查询。三者复用同一能力描述、参数校验和执行路径；编辑器仍持有作者状态，RenderPacket 是投影。逐步做独立作者 API 时，也消费既有作者合同，不能把 DeepSceneState 校验模块直接升级成第二份产品真值。

最短循环：需求 → 生成/修改源码或作者场景 → 渲染 → 图像与结构化诊断 → 局部修改 → 保存与重开验证。Skill 教如何使用，MCP 提供运行能力，二者不承担渲染逻辑。

## 五项交付

### 1. 少量、稳定、带类型的作者 API

先覆盖 AI 高频场景：对象组、基本几何、GLB/工业模型、PBR/Unlit 材质、灯光、相机、动画与输入。对象使用稳定 ID，颜色空间、米/秒/弧度、坐标系和材质范围有统一定义。创建入口给可直接出图的默认相机、光照和环境；允许全部覆盖，并支持现有宿主自己的帧驱动。

保留命令式 JS/TS 与声明式配置两种写法，声明式配置不是唯一通道。专业用户可接自定义几何、实例化、着色器、插件和运行中脚本；高层 API 不要求用户手写 GPU ABI。每个公开入口包含最小真实例子、参数类型、失败返回和资源释放方式。

首批模板选 8 个：基本场景、产品材质、工业车间、分层钻取、设备告警、机械动画、粒子效果、资产导入。使用真实 SDK 导出，空项目安装后能运行，图像与示例版本绑定。新 API 稳定前不在 Skill 中使用拟议名称。

### 2. AI 能看见并定位问题

补齐按需截图工具：返回 PNG/WebP 的 MCP image content 或可读图像资源，带 sceneRevision、frameId、相机和实际渲染后端。HDR/深度原始数据仍保留为专用诊断资源，不塞进每次工具文字结果。黑帧也要有可定位原因，例如未发布场景、相机看空、纹理失败、编译失败或设备丢失。

查询提供对象 ID、包围盒、父子关系、可见性、材质、屏幕位置；复用既有拾取与空间查询。诊断映射回 object/material/source，而非只返回 pipeline 或 bind group 数字。性能反馈给帧时间分布、draw/triangle/upload/资源占用及统计口径；GPU timestamp、驱动显存不可得时如实标 unavailable，不能用估算冒充。

所有抓图、深层查询和读回按需执行；默认正常帧不强制 GPU 同步。视觉回归仅深色 1920×1080，数值附件保持冻结尺寸。失败保留 last-known-good，AI 修改不会让用户连续看空白画布。

### 3. 小而完整的 MCP 与 CLI

先修现有路由的标准参数接线、图像返回和客户端握手，不重建注册表。HTTP 接入以现有服务为基础；本地 stdio 如确有需求，只做同一执行路径的薄适配。客户端 OAuth/令牌与会话选择单独验证，不把用户凭据放入示例或 Skill。

下表是拟议能力分组，最终名称从既有 registry 生成；不是另注册一批同义工具。

| 能力 | 代理需要拿到的结果 | 复用入口 |
|---|---|---|
| 能力与文档检索 | 当前支持范围、版本、类型、最短样例 | capability manifest、SDK 文档与 registry |
| 场景查询 | 当前场景/选中对象、按 ID 分页查询 | editor presence、scene resources、现有 SceneQuery |
| 批量修改 | 单事务 diff、revision、可重试冲突、撤销结果 | SceneCommandTransaction 与作者命令路径 |
| 渲染与诊断 | 实际图像、对象定位、资源/帧指标 | editor snapshot bridge、现有 renderer diagnostics |
| 资产与构建 | 资产 ID、解析结果、类型错误、实际首帧 | 现有导入、SDK build 与运行门 |

工具发现按主题/需要展开，不把整个工业注册表与场景 JSON 每轮灌给模型。长任务可查询状态、取消和恢复；响应优先给小摘要与资源链接。事务支持幂等 ID、revision 冲突与回滚；并行代理修改不同文件或场景区域，提交作者状态时处理冲突，不增加全局审批队列。

CLI 镜像需要的能力，用于模型能直接改源码的场景；MCP 用于源码无法表达的运行时状态。两种方式可混用，不强制所有开发都绕 MCP。工具结果有明确成功/失败、定位信息和下一可执行动作。

### 4. 一份 Skill，适配 Claude 与 Codex

维护一份 canonical `SKILL.md`，短正文只写选择入口、运行、观察、修正与释放。类型、长示例、材质参数和工业专题放 references；构建/抓图/诊断脚本复用项目现有命令。版本来源是公开 SDK/registry，发布时检查示例实际导出，避免模型照文档调用不存在的函数。

官方目前的仓内入口分别是 Codex `.agents/skills/<name>/SKILL.md` 与 Claude Code `.claude/skills/<name>/SKILL.md`；安装/分发生成两份相同内容或使用客户端支持的链接方式，不手写两套规则。客户端 MCP 配置单独生成，并保留用户现有配置。[Codex Skill 文档](https://developers.openai.com/codex/skills)、[Claude Skill 文档](https://code.claude.com/docs/en/skills)。

建议首个 Skill 叫 `deep-engine-3d`：按需求选模板 → 用真实类型写代码 → 启动 → 看截图/诊断 → 只修改相关对象 → 验证保存与释放。可另分材质、工业导入专题；不为每个函数创建一个 Skill。首批先支持真实可用子集，能力扩大时随 SDK 一起更新。

Claude Code 与 Codex 都支持本地 stdio 和 HTTP MCP，可共用服务器实现；配置文件与身份接入按客户端处理。发布门必须包含两种客户端实际连接、tools/list、查询、修改、截图和取消；仅 API inject 测试通过还不够。[Codex MCP 文档](https://developers.openai.com/codex/mcp)、[Claude MCP 文档](https://code.claude.com/docs/en/mcp)。

### 5. 利用 Three 生态，建立真实评测

先做有界迁移映射：Group/Mesh、常用几何、Standard/Physical 支持子集、灯光、相机与 GLTF 的对应关系；编写可检查的迁移样例或 codemod。已存在 ThreeProjectionBridge 可服务当前迁移期，但独立使用的新模板必须最终检验不需要 Three 运行依赖。第三方 addon、自定义 onBeforeCompile 与任意 GLSL 不自动承诺兼容，报告具体未映射位置并给可操作的原生实现入口。

建立 20 个真实任务基准，覆盖从零生成、根据截图修改、修黑帧/材质/遮挡、动画、导入、性能优化、保存重开与设备恢复。固定同一需求/资产/预算，对比 Three 的实际实现及我们的实现；记录首帧时间、任务成功率、工具次数、token、修复次数、图像检查与运行性能。用户满意度与性能需要实测，不能用源码行数或模型名字替代。

## 自由度与 Harness 的调整

默认沿用用户授权自主执行可撤销的建模、材质、相机、动画与脚本修改；授权在任务内持续有效，不重复逐对象确认。用户可选计划模式、交互模式或自主模式，并设置资源/时长预算与模型、工具偏好。取消、撤销、审计和候选原子发布用于恢复，不能变成每一步的审批负担。

现有固定 `CURATED_TOOL_IDS` 适合原工业任务目录；通用开发模式应按用户授权与已注册能力发现工具，继续复用可靠执行、取消和 ProvenanceLedger。专业自由脚本仍按 H-C6-S1 打通，不把只能修改属性的 SceneCommand 白名单当成完整开发能力。涉及用户没有授权的外部发布/控制动作再处理确认；不扩大到无关项目。

实现只保留一套 Harness、记忆与执行账本。Claude/Codex 可以直接作为外部编码客户端接入，并不要求先使用产品内置 AI 聊天界面；数据中心本体与工业语义是可选增强上下文，不成为“画一个立方体”的依赖。

## 推荐落地顺序与验收

| 顺序 | 最小交付 | 依赖与估时口径 |
|---|---|---|
| 1 | 核查并修 MCP snapshot 标准参数；打通真实 PNG 图像；两个客户端读/截图演示 | 复用现有 MCP/readback，预计 4–8 工时；属于现有 H 接入缺口 |
| 2 | 发布已支持 API 的 8 个可运行模板、版本化 references 和首个双客户端 Skill | 现有 Web SDK 可先做，预计 8–16 工时；部分复用 SDK/文档工作 |
| 3 | 原生作者 API 高频创建/删除/层级与批量事务；CLI 对应入口 | 先锁作者合同，不另立状态树；预计 24–48 工时，须与 C24/H-C6 合并计数 |
| 4 | 完整对象定位与性能反馈、Three 高频子集迁移、20 题 AI 任务基准 | J/C 与相关 I 能力作为实际支持边界；预计 24–48 工时，依验收范围再锁定 |

上表分别登记为H-C7-P1/P2/P3/P4，已并入权威清单和剩余估时表。新增去重60–120h；H-autonomy、H-C6-S1与K17/现有诊断原范围不重复计入，C24合并P3。原57项范围保留历史口径，新总表61项；J/C/I主线不为本文重新排队，完成对应依赖后沿上表交付。

第一版的验收是：在空消费项目安装 SDK/Skill，Claude 与 Codex 各完成一次生成 → 实际截图 → 修改一个指定对象 → 保存/重开，支持取消与撤销；依赖、命令、图像、场景 revision 均可追溯。后续版本再扩大几何、材质、工业格式和跨端范围。

重点判断：先让 AI 用少量稳定入口获得真实好结果，再逐步覆盖 Three 的高频生态与高级自由开发能力。SDK 易学、视觉反馈可靠、迁移成本低三者缺一，Skill/MCP 都只能补外围。
