# 剩余任务与估时（2026-09-30，北京时间）

这份表给继续开发和排程用：只估真实后继缺口，已完成首刀不再排一遍。主线顺序 **J/C → G → F → 其他 → 最后验收**；2026-09-30 用户指定另设唯一 I 子智能体，与 J/C 并行推进，依赖未就绪时先做 I 内独立切片。

**原锁定57项已关闭6项、剩余51项；用户新增AI方案4项，当前共61项、剩余55项，净投入355–724小时（约45–91个8小时人日）**。已关闭C4生产录制、Native可选输出profile、I-C26公共编译诊断、C5固定Bullet参照记录、I-C25实际Play恢复与I-C15生产局部反射。原57项后继净投入295–604小时，AI新增去重预算60–120小时；包含必要测试、类型检查与实机验证。历史T00–T32另21组尾项核查27–54小时，含核查共382–778小时，四路约18–45个8小时工作日。未知全包范围仍待锁定；工时为工程投入估算。

原57项进度6/57=10.5%，加入AI方案后的当前61项进度6/61=9.8%；J/C后继10项为3/10=30%，I后继10项为3/10=30%。C5按独立参照记录范围关闭，不认证求解器准确度等价。Gate D/C8/CSM完整能力仍保留。用户对C8截图指出Deep偏亮、光泽/质感不足：后继优先改进Deep实际直射材质链，保留原Three默认对照，不用降曝光或削弱对照端通过画质门。后续视觉测试只用深色1920×1080，数值GPU附件保留冻结尺寸。

最新收割 `3aaeec5e`：C15生产双探针/作者保存重载/盒边过渡/回收整项关闭；C8-S5直射材质子集display最大差1，strict HDR仍有残差，不关闭整项。最新strict其余24腿通过，窗口suite修正实际loss等待边界后独立fresh双端/候选复测通过；保留首次失败全量记录，不当作新26腿全量运行。

## 现状核查

1. 源码与未跟踪：检查 packages/apps、`git status --short`、本轮输出/生命周期/流场草稿；没有从旧“无产出”状态重新立项。
2. 契约：读 contracts、lighting/shader/runtimePackage 类型；查已存在的自由 JS、受限图、Study、录制、权限和生命周期消费语义。
3. 依赖：package.json/Cargo.toml 的 Three、esbuild、Vitest、Playwright、wgpu/serde/Rapier/ONNX 与数据协议设施已覆盖主要工作；离线路线保留。
4. 消费方：定位 C4 录制条件注册、C8 GLSL 的真实 Three OutputPass 接线、Native 四输出变体公共源、GI storage/texture 实际采样差异、工艺变更 UI、粒子掩码、AI 轮询/记忆/历史等实际入口。
5. 测试与证据：核对提交记录、本轮 1,712 测与两轮 GPU 对拍、T00–T32 实施报告、研究收尾报告。历史报告未更新的“未接/partial”逐项与后续提交对账。
6. 规格：权威清单为 `D:/Documents/bim/deliverables/research-20260928/剩余任务清单.md`；读本日 handoff、核心能力计划、J3/C8/G2/Z1 规格和恢复台账。09-28 历史条目不能盖过 09-30 实现证据，恢复台账已同步最新切片。

**已有（不重建）**：C18 核 `a4c12e10`；J2-B1/B3/B7、J4/J5；C1 工艺变更 UI `9384c490`、C2 准入/校准/生产门、C3 马达齿轮 `743f1014`；A2 SDF/A3 布料 GPU、F1/F2/F3/F5/F6 已完成切片；I-C6/C9/C10/C11/C12/C13/C21/C25/C26 已完成范围；H-C1/C2/C3 与 H-A1/A2/A3 实现；G2-S2a；自动曝光/体积雾修复。J2-B2、Gate D 输出子集、Gate E 真实宿主 CPU 生命周期、C8 库对拍首刀本轮已过，排除首刀本体。Gate E 为 5 场景×2轮、每轮28阶段样本、native 12测通过、dispose 后CPU资源0；没有将它当作显存零泄漏证明。

**真实缺口**：CPU/库首刀之后的生产接线和全面对拍；自由脚本/自动记忆/编辑器全入口；现码仍存在的 K8/K9/K10/K11/K13/K15/K16/K17 等。交接“全部 K/T 批”并不等于 K1–K18 全清：`b65eb391` 仅 K2–K6，K7 与 K12/K14 各有其他提交；例如 chat 请求没有整体 deadline、agent runId 仍存单槽、web/api 无 renderer manifest 消费，不能删掉这些真实任务。

**第三波已验范围（不重计）**：J2-B4 边界防护已提交 `e7892afc`；共享小核、linear 过滤边界与帧时仍后继。C8-S2 已接生产 Three OutputPass，10 配置×2轮共20帧最大 byte 差0，只共享 ACES，直渲材质与完整双后端链仍归 C8-S3。J2-B2-N 四变体共用显示数学与作者分级，Native RTX4060/Vulkan 两轮96组，CPU最大误差0.00048822165（既有RGBA16F阈值0.002），跨变体/alpha误差0、GPU错误0，合同11测通过。J2-B5 十情景两轮 storage 向量双宿主最大差5.960464477539063e-8；本刀未替换生产storage/texture采样，完整帧未覆盖。第三波36文件已提交 `cbce805a`，未推送，旧证据清理与失败路径修复属于该切片收口；不写成整项通过。

## 估时口径

**第四波已验范围（不重计）**：B4三族生产共享混合核与Chrome边界已验，Native生产CSM回归通过；只留linear过滤、Native同七点与帧时2–4h。Gate E本次双端实际destroy/lost/reopen及有效首帧已验，每端两轮18阶段、Native每轮6611非背景像素、Web239像素，重建前后HDR/CSM各自全等；自动unknown-loss/窗口/编辑器/驱动显存/上传/帧时仍6–12h。B6共同软膝生产接线已验，64组Chrome GPU前后全等、CPU相对误差3.725290298461914e-9、NativeBloom实机通过；不同采样/blur非均匀HDR与Fog仍6–12h。本波严格J5九对十八腿含GPU、degraded=false（`evidence-20260930052206.json`），core/lab/examples类型及runtime freshness通过；第四波提交状态由主线收尾更新。

- **小时指净工程投入**，包括读现状、实现和必要验证，不是 AI 连续运行的墙钟承诺；1 人日=8 小时。不把几分钟单测时间当成整个产品切片耗时。
- **高信心**：定位到少数接线/错误路径及现有测试；**中信心**：既有核可复用但跨端/实机/用户面需补；**低信心**：多家族语义、profile 或算法边界尚需压缩。
- 依据：叶子接线通常 1–4 文件；双端首刀需要合同/TS/Rust/脚本/样例共约 6–12 文件；完整材质、路径追踪或脚本通道还涉及恢复、取消和产品体验。旧 N 方案 31–56 人日不是当前残量，也不直接照搬。C18 曾有 58 分钟无进展与收割，证明等待≠有效实现；本轮 GPU 两轮和207文件单测是已有自动验证基建，降低复测成本，不能外推全部能力数小时完成。
- 新发现缺陷、模型/设备矩阵扩大与未知 T 包实现另作增量。GPU 未测是待验证，不自动算外部阻塞；先用本机、缓存与现有工具推进。

## J 系列

| ID | 具体剩余缺口 | 依赖 / 已有底座 | 净工时 | 信心 |
|---|---|---|---:|---|
| J2-B2-N-next | 已关闭：可选profile贯通发布/运行包/parser/host/output与热切换；旧缺省字节保持 | 75421e61；224组GPU、黑背景重建、WASM/freshness通过 | 0h | 已完成 |
| J3-D-full | HDR、阴影/法线与后处理逐层双端实渲对拍；扩展合法差异矩阵 | ae9a3d77几何/主深度已验，同包双相机双轮；J2-B5/B6 | 8–16h | 中 |
| J3-E-GPU | 自动unknown-loss、Native窗口事件/present、完整编辑器状态、驱动显存/上传与帧时；扩展实际epoch首刀之外的恢复 | 双端真实destroy/lost/reopen/首帧稳定已验；CPU首刀 | 6–12h | 中 |
| J2-B4 | linear PCF过滤边界、Native共同七点输入、跨设备与帧时；保留宿主级联数差异 | 三族共享混合核、Chrome边界及Native生产GPU已验 | 2–4h | 中 |
| J2-B5 | 共享storage核生产适配与Web texture语义矩阵；共同非均匀场景HDR帧、动态GI/漏光与帧时对拍 | 十情景storage双宿主向量已验；J3-D与既有帧入口 | 3–6h | 中 |
| J2-B6 | 不同非均匀HDR采样/blur/pyramid profile对拍；Fog模式/参数/高度/HG合法差异与实帧 | 共同软膝生产接线、64组前后全等、NativeBloom已验；J3-D | 6–12h | 中 |

本组：25–50h。同一缺口跨编号合并一行，不重复计时。

## C 系列与本轮提级的 C8

| ID | 具体剩余缺口 | 依赖 / 已有底座 | 净工时 | 信心 |
|---|---|---|---:|---|
| C8-S3 / I-C8 | 材质/灯光数学真实消费与完整链分批对拍；直渲ACES不再重复 | 5f8d0f51两轮40真实配置byte差0；现有DCIR/WGSL-first | 12–24h | 低 |
| C4-recording | 已关闭：API生产组合与用户录制/历史/重开/三轴/Study副本入口 | a23def9e；25聚焦测、API/Web类型及两轮生产CI通过 | 0h | 已完成 |
| C5-oracle | 已关闭：固定Bullet堆叠/铰链/齿轮/滑轨/布料双轮参照与差异，匹配有限刚度子集步长收敛；零产品运行依赖 | test-output/c5-bullet/evidence.json currentRun=true；accuracyEquivalent=false | 0h | 已完成 |
| N10-geometry | 互锁粗筛之后的机器人连杆/工具/工件窄相位与时间扫掠，出碰撞时刻和最小间距 | 已有 RobotSyncPanel/FK/IK/BVH | 12–24h | 中 |

本组：24–48h，C5参照记录关闭后扣除4–8h。同一缺口跨编号合并一行，不重复计时。

## I 系列后继切片

| ID | 具体剩余缺口 | 依赖 / 已有底座 | 净工时 | 信心 |
|---|---|---|---:|---|
| I-C1 | 3DGS slot/管线/排序接生产；真实 GPU 出图、mesh 共存、SH 高阶目前仅存储的呈现边界 | d60ae021；现有 PLY/splat 真样本 | 8–24h | 中 |
| I-C15 | 已关闭：生产双 cubemap/盒边混合，编辑器保存重载/非法值保持与候选回收；Deep WebGPU范围 | 3aaeec5e；实际两GPU realm/两作者context、11权重点、资源54→56→54→0 | 0h | 已完成 |
| I-C16 / T10 | 离线路径追踪出图产品模式：累积/材质变更失效/取消/导出及收敛对照，复用 MC/RT 参考 | 现有软件 BVH/RT；J 门 | 24–48h | 低 |
| I-C17 | 现有流场 WGSL 草稿补消费/预算/确定性/可关停/真机量化，复用粒子运行时 | 在树 particleFlowField；T20 | 6–12h | 中 |
| I-C18-next | 已完成 god rays 核之外的产品 GPU dispatch/遮挡资源/效果设置与两轮实际画面证据 | a4c12e10；体积雾产品桥 | 4–8h | 中 |
| I-C19 | 动态 IBL 投影阴影：已存在 HDR IBL 上增加更新/失效/资源预算与实际帧对照 | HDR IBL；I-C15；J3-D | 12–24h | 低 |
| I-C21 | HDR 显示策略接 Studio 桥与真实 HDR 面板端到端验证；面板不可用时保留显式未测 | c1e13bbd；现有 PQ/HLG GPU 证据 | 4–8h | 中 |
| I-C23 | 分层材质响应核接生产 GPU、按层表面色差异/纹理与双端白炉 | 9c56b1fc；C8/J3-D | 8–16h | 中 |
| I-C25 | 已关闭：真实非空Play恢复分段计时、双失败重试、两个加载竞态与成功后旧错误清除 | 34测；显式WebGL/无renderer参数各两轮；相机/对象恢复、bounded measure、页面错误0 | 0h | 已完成 |
| I-C26 | 已关闭：公共冻结快照、4096日志预算与两轮实际编译等待/同设备复用量化 | 334d3d93；31测、两轮实际首帧/复用/残留0；墙钟观察值非帧时收益 | 0h | 已完成 |

本组：66–140h，I-C15关闭后再扣除4–8h。同一缺口跨编号合并一行，不重复计时。

## G 系列

| ID | 具体剩余缺口 | 依赖 / 已有底座 | 净工时 | 信心 |
|---|---|---|---:|---|
| G2-S2a-visual | 拖入/连线/改表达式/保存/非法拦截五路径两轮深色1080截图 | 7ecb030b；独占浏览器验收 | 2–4h | 高 |
| G2-source-write | InteractionEditor 所有受限源码写回通道复核并收口，合法专业 JS 通道保留 | 现有草稿门；本机未跟踪 behaviorGraphDraft | 2–4h | 高 |
| G2-S2b/S2d | Play 草稿/重新应用状态与轨迹回放 UI；复用同真值文档和现有日志 | S2a；T31 日志/Play | 6–12h | 中 |

本组：10–20h。同一缺口跨编号合并一行，不重复计时。

## F 系列

| ID | 具体剩余缺口 | 依赖 / 已有底座 | 净工时 | 信心 |
|---|---|---|---:|---|
| F1/B1/T01/T25 | 已接计时之后补真实执行 coverage、常规 frameGraphReceipt、内部上传/可见量读数；无新增同步等 GPU | 2caab70b/74432bca；现有帧图 | 4–8h | 中 |
| F2/B4/G1/T05/T26 | 驻留感知 HLOD/簇隐藏生产 transport/pass 接缝与冻结场景 GPU/对象 ID/轮廓/时序 Hi-Z 对照 | af3d7f6b/643046c8/2baa0b45；B2 | 6–12h | 中 |
| F3/T06 | 页表/反馈已接，补 SSIM≥0.99、相机往返抖动/预算恢复/取消泄漏真机证据 | 7e271afe/beacb6a2 | 3–6h | 高 |
| F4/B3/T07 | 自有上采样核进产品目标与历史，67% 分辨率四序列画质/帧时报告；透明/粒子掩码已有 | 既有 scaler/MRT reactive；J3-D | 6–12h | 中 |
| F5/G3/T02 | Chebyshev/实际产品多尺度薄壁与动态场景视觉闭环；32 方向/失效收敛/一阶多散射已做 | a6e8a304/42954e5b；J2-B5 | 4–8h | 中 |
| F6-A3 | 生产换核后全 substeps 单 pass 真 GPU复验、FMA 容差/核选择会话口径与缓冲会话化 | 3206952f/b06d8086；Cargo 串行 | 4–8h | 中 |
| F6/T18-collision | 布料/软体风场与碰撞、软体并行、顶点流生产消费；CPU/GPU 参考不重建 | A3；Rapier/BVH；T17 | 12–24h | 低 |
| A2-next | SDF barrel 导出、真实 WebGPU 查询探针及凹体消费 profile 接缝核查；不重做 SDF 核 | 13eb2187；既有 native 参考 | 3–6h | 中 |

本组：42–84h。同一缺口跨编号合并一行，不重复计时。

## 其他：Harness、工业与编辑器

| ID | 具体剩余缺口 | 依赖 / 已有底座 | 净工时 | 信心 |
|---|---|---|---:|---|
| H-C6-S1 | 自由 JS/TS 脚本运行中热插、场景读写/暂停/快照恢复；复用既有隔离/事务/预算/轨迹，不逐条审批 | 既有 trusted JS/Play/transaction bridge | 12–24h | 中 |
| H-C6-S2 | 专家日志→归档→提炼→下轮自动回灌；复用 agentMemory/ProvenanceLedger、取消与提炼预算 | H-C1/C2/C3 已有；K8 | 8–16h | 中 |
| H-C6-S3-inventory | 全量编辑器/API/运营中心能力入口对账，按业务路径产出接入矩阵 | 现有 Study/报告/分析/工艺入口 | 2–4h | 高 |
| H-C6-S3-connect | 补首批确定缺失入口与真实浏览器路径；全量批数由 inventory 锁定后再重估 | S3-inventory；现有用户面 | 8–20h | 低 |
| H-autonomy | 授权范围/执行模式可配置，已授权修改自主执行，取消/回滚/审计继续有效；通用开发模式按授权发现已注册工具，专业脚本不逐条审批 | ontologyAction/agent 网关/权限合同；H-C7共用此项不另计 | 6–12h | 中 |
| H-C5-K8 | 记忆回灌失败落审计 finding/可重试信息；现码 postExecute 异常被吞 | agentHarnessGuards/orchestrator | 2–4h | 高 |
| H-C5-K9 | chat 整体 deadline/停止/超时语义，处理 SSE 挂死 | runAssistantRequest/useAssistantChatRun | 2–4h | 高 |
| H-C5-K10/K11 | 轮询退避/错误节流；恢复失败显示 runId 与恢复入口，陈旧/跨项目状态明示 | IndustrialAgentWorkspace | 2–5h | 高 |
| H-C5-K13 | 多运行历史与可恢复入口；现码单槽 runId localStorage | 既有 run API/账本；K10 | 2–5h | 高 |
| H-C5-K15/K16 | 存储配额与模型错误分型；网络错误本地化与恢复动作 | 现有 errorMessage/sessions | 2–4h | 高 |
| H-C5-K17 | 实际 renderer capability 清单用户面与 Harness 上下文消费，降级状态可定位 | J4 既有 manifest；H-C4-P2 | 4–8h | 高 |
| H-C5-K18 | 当前 chat/agent 失败、恢复、应用失败的相邻路径回归缺口对账并锁定 | 已有 T8/UI 测试，不重复镜像测试 | 2–4h | 中 |
| H-C5-T1/T4 | 澄清候选服务端透传/审计档案浏览端点，复核已完成 carrier 后的实际链路 | 既有 needs-input / provenance.trace | 4–8h | 中 |
| H-C5-T5 | 逐条引用与真正证据锚对齐，复用 K1 校验器和现有指纹载体 | chatEvidenceGate；H-C4-P2 | 6–12h | 中 |
| H-C5-T7 | dashboard 流式真实布局预览，现有 shimmer 之后的可感知产品状态 | 现有 dashboard parser/renderer | 4–8h | 中 |
| ENG-runtime-purity | pipelineCache.ts 与 virtualTextureFrameBridge.ts 共5处 performance 访问修为既有宿主时钟/诊断边界注入；不扩大allowlist掩盖纯运行时约束 | HEAD同内容基线已证明；runtimePurityGate/现有时钟抽象 | 1–2h | 高 |
| ENG-source-size | 18个既存超800行文件按职责拆分，生成表分片；保留公开入口/类型/消费方并做聚焦回归，不加allowlist | 本轮全仓source-size门18项失败，当前切片修改文件均低于300行且未改这18文件 | 20–40h | 中低 |
| D2/T23-gradient | 解析机构链梯度 vs 有限差分，辅助本地标定；不加通用可微引擎 | T17 黄金/现有校准 | 6–12h | 中 |
| N5-material-import | 第三方 GLB unlit/无 TANGENT profile 的导入/生成/损失处理，避免零配置样板被拒；范围先核查 | 现有 glTF/质量合同/几何工具 | 4–8h | 中 |
| H-C7-P1 | 修快照标准MCP参数与可视PNG返回；Claude/Codex实际握手、查询、截图、取消；对象定位与性能口径接现有诊断 | 现有MCP/readback/registry，H-K17；不重建服务器 | 4–8h | 中 |
| H-C7-P2 | 8个空项目可运行3D模板、版本化references、一份Skill生成双客户端分发，示例类型/导出/运行门 | 现有独立Web SDK消费门；P1提供视觉循环 | 8–16h | 中 |
| H-C7-P3/C24 | 原生高层作者API：创建/删除/层级/材质/相机与批量修改，CLI复用同执行路径；保存重开/取消/撤销 | 作者合同/SceneCommandTransaction，H-C6-S1；共享自由脚本与授权工时不重复 | 24–48h | 中低 |
| H-C7-P4 | Three高频子集迁移映射与可检查样例/codemod；20题真实生成/视觉修正/性能任务基准 | P1–P3、J/C/I已验能力；不承诺任意addon/GLSL自动兼容 | 24–48h | 中低 |

本组：157–320h，新增AI方案净增60–120h，H-autonomy/H-C6/K17等共用工作不再计入P1–P4。方案与完整验收条件见 [面向AI的3D框架](ai-first-framework-and-agent-integration-20260930.md)。组内执行先P1→P2→P3→P4，P3与H-C6-S1接线协调；主线仍J/C→G→F→其他→最后验收，I独立并行。

`ENG-source-size` 的18文件当前行数：conversion 1141、industrialCapabilities 801、App 851、runtimeEffects 988、platform-components 875、StudioDeepWebGpuBridge 992、contractsScene 979、ltcTables 1495、pbrRenderer 987、native_character 893、native_physics 1217、mechanism 839、navigation 1181、dynamicScene 866、clothCompute 939、clothSolver 889、wasmLib 1024、psgeometry 1496。这是历史工程债的新排程项，本轮未改这些文件。20–40h为中低信心范围：体量已知，实际模块边界、生成表分片及Rust私有访问拆分仍需核查；包括消费兼容与聚焦验证，未混入功能行重复计时。当前不拆无关文件，全仓体量门仍未绿。

## 最后验收（E/Z，日常切片验证已经计入各行）

| ID | 具体剩余缺口 | 依赖 / 已有底座 | 净工时 | 信心 |
|---|---|---|---:|---|
| B2/T11 | 冻结树 A/A+A/B 冷暖切/输入 P95/P99/有效首帧/20 次进出内存；未达按瓶颈补最后优化 | 功能切片结束；计时与预热已接 | 6–12h | 中 |
| E1 | 断网整机闭包：安装包→导入→仿真→报告→保存重开→证据与录制复盘 | C/H/T24；本地离线依赖 | 4–8h | 中 |
| E2/Z4 | 全页面关键路径两轮深色1080；只修实际视觉回归 | 各用户面完成；设计令牌；按用户新矩阵执行 | 8–16h | 中 |
| E3/T23-time | 30/60/120Hz 和非整倍帧率工业时间/余量/事件对拍，复用 C4 已有三轴单测 | T19/Play/录制；现有时间合同 | 3–6h | 中 |
| E4 | 维护净空人体/工具/拆卸件 sweep 与 BVH 复用核查；有缺口再立局部 profile | 既有测量/Case/BVH | 2–4h | 高 |
| Z2/Z3/Z3.5 | 零配置拖模型样板；SSR/接触阴影/bloom/暗角与软阴影默认预设，自动性能档及细调/回退实际验证 | J2-B6/F4；曝光/雾修复已完 | 6–12h | 中 |
| Z5 | 消费方与价值审计：T13 散布、账本 settle warning 等；无收益不继续微优化 | 用户路径与已有量化证据 | 2–4h | 高 |

本组：31–62h。同一缺口跨编号合并一行，不重复计时。

## 历史 T 全包的剩余范围校准（不把旧 partial 当新建需求）

下列工时**仅为核查与范围锁定**。这些项来自 T 实施报告明示尾项，部分已被 09-28 至 09-30 接线覆盖；需要确认具体消费路径、后续提交和已有测试后才估完整实现。不给未知工作包一个随意的整包数字。核查时若证明已完成，删对应待办；若仍缺，把最小生产闭环拆进前面的执行表。

| ID | 需要锁定的具体范围 | 依赖 / 核查入口 | 核查工时 | 信心 |
|---|---|---|---:|---|
| T00 | 跨 GPU/驱动/浏览器矩阵、Unity 同素材配对与无头批处理：历史基线已有，需核对当前入口及设备覆盖 | 基准脚本/test-output/固定素材 | 2–4h | 中 |
| T08 | 分层以外的各向异性/透射 IBL、SSS/毛发节点；求值核/材质导入已接，先查实际生产缺口 | 材质 GPU 黄金/Shader Graph | 1–2h | 低 |
| T09 | 大气天空/体积雾已有，体积云、水反射折射/多灯雾剩余消费与 GPU 范围 | C6/C18、fog/weather、水面链 | 1–2h | 低 |
| T12 | L5 重命名/删除引用影响、稳定语义绑定、插件权限 E5；资产包/UV/几何核已完成 | reimport/quality/依赖图/SDK | 1–2h | 中 |
| T14 | 根运动旋转/UI、Native/WASM 统一播放链、父链动画/多 clip、100/1000 GPU 骨骼成本；TS 根运动与 pose 优化已有 | gltf/renderAnimation/Three 投影 | 2–4h | 低 |
| T15 | Native/WASM/GPU IK、脚滑、大库姿态索引/过渡混合、A5 骨架命名；不能重做52测数学层 | IK/rig/重定向/姿态搜索 | 2–4h | 低 |
| T16 | 角色根运动与编辑器、滑坡/查询 BVH、镜头编排与离线 morph；既有 SceneTimelinePanel/camera 不从零 | characterMotion/player_content/camera | 2–4h | 低 |
| T17 | 凹体凸分解/B-Rep 直读、collider 来源 UI、WASM 黄金与通用容差冻结的真实剩余 | CAD→collider、SDF、ScenePhysicsPanel | 1–2h | 中 |
| T18 | 除已列 F6/A3 外的毛发、破碎、车辆接触/悬挂及宿主渲染；赛车级轮胎/动态断裂已排除 | 50测 CPU 参考、Rapier、morph | 2–4h | 低 |
| T19 | navmesh/动态障碍/坡度步高、对向窄道、10k 到达与跨端统一时钟/SoA ABI | navigation/AGV/SimulationEngine | 1–2h | 低 |
| T20 | 除 I-C17 外的粒子透明排序/曲线 LUT/火焰预算遥测、有边界烟体求解；通用流体已排除 | gpuParticleRuntime/模型火焰/B3 MRT | 1–2h | 中 |
| T21 | 2D 骨骼/独立2D物理/UIA跨层与移动触控/动作映射；10万行/IME/文本矩阵已有 | retainedUi/Deep2D/input；既有浏览器 | 1–2h | 低 |
| T22 | JT 8.x 网格/PMI、X_T 曲面与生产 profile、PMI/装配/材质语义；被删除样本追索不得复入 | 工业格式唯一计划、现有 parser/fixtures | 2–4h | 低 |
| T23 | C2 校准集已完成之外的离线数据质量/谱系、告警原因→历史回放业务链 | plant-lite/Study/数据绑定/录制 | 1–2h | 中 |
| T24 | SubscriptionTransfer、签名/加密证书、backfill 与质量可视化；持久订阅和文件 checkpoint 已完成 | OPC UA/MQTT/订阅 runtime；不追PLC | 1–2h | 中 |
| T27 | 事务标签/低频域记账/长事务/崩溃草稿的真实余项；Undo/Redo 与 Play 隔离已做 | scene history/transaction/persistence | 1–2h | 中 |
| T28 | Native/WASM 在线调试/逐帧桥；导入录制与曲线对比已交付 | PhysicsDebugPanel/现有物理桥 | 1–2h | 中 |
| T29 | 告警挂载、ambient 合同、多声源混音与 Native/WASM 3D声音；现有MP4音轨不等于空间音频 | audio director/viewer/native dashboard_audio | 1–2h | 中 |
| T30 | Native/WASM Play语义、热应用和会话遥测；Web App 进入/恢复及增量恢复已做 | useScenePlayMode/Native/WASM hosts | 1–2h | 中 |
| T31 | Native 行为 IR、点键表达式、回放；命令适配/App接线/文档持久化已完成，不重建 | restrictedCommandAdapter/behaviorTraceLog | 1–2h | 中 |
| T32 | 非 battery 模型与 API 网关消费、GPU EP逐模型黄金、vision 薄迁移；CPU参考网关已有 | onnxInferenceGateway/vision/模型清单 | 1–2h | 中 |

T 全包索引对账如下。标“已覆盖”只指本次估时归属，不宣称整包已全验：

| 原包 | 归属与处置 |
|---|---|
| T00 | 遗留矩阵核查 + 最后 E/Z 基准；已有 fixture 不重建 |
| T01 | F1/B1 与默认档 Z3；质量/诊断合同已有 |
| T02 | J2-B5、F5/G3；32方向与失效收敛不再做 |
| T03 | 反射融合四序列已有；I-C15、J3-D 后继覆盖 |
| T04 | F7 已评估保持实验；J2-B4/默认软影与 I-C2 真机已做部分不重建 |
| T05 | F2/B4/G1 与对象级/时序Hi-Z对拍 |
| T06 | F3；页生成/反馈/接线已经完成，不新建纹理系统 |
| T07 | F4/B3；透明与粒子掩码供给/MRT/动态分辨率已接 |
| T08–T10 | I-C23/C18/C16 与上述 T08/T09核查；RT 探测已有，native RT/raster证据要复用 |
| T11 | B2 复测，计时/编译/驻留/C25已接，不再从零提速 |
| T12–T16 | 上述逐包核查；T12资产包/UV、T14事件/平移根运动、T16角色状态核心已有 |
| T17 | C3/C5、A2 与来源UI/WASM核查；四黄金核心已有 |
| T18 | A3/F6 与毛发/车辆/预破碎核查；自碰撞仍独立子项 |
| T19–T24 | 上述逐包核查；C4录制、E3时间、N10扫掠、既有OPC UA订阅复用 |
| T25 | F1覆盖/诊断；面板已交付，不重建Profiler |
| T26 | F2/B4/G1；HLOD生成/API发布/合批已有 |
| T27–T32 | 上述逐包核查 + G2/H-C6；Play/Undo/图命令/ONNX网关已有，不复制时钟或执行器 |

## I 系 24 项与重复编号对账

`C` 在本地研究里有“工业 C 级”和“I 级候补 C1–C31”两套命名，本表显式写 `I-C` 防混淆。

| I 系编号 | 当前处置 |
|---|---|
| C1/C8/C15/C16/C17/C18/C19/C21/C23/C25/C26 | 前表明确后继缺口；首刀和已完成生产部分不重复计时 |
| C2 | 集群光源剔除 `840dedc0` 已实测；全面宿主能力差异沿 J4 清单/双端门核查，不重做万灯算法 |
| C3 | LTC 单源核已在 `ltcAreaLighting.wgsl`；TS/native 最终材质/软影消费范围在 J3-D、T04核查，不因旧误收提交复制第二核 |
| C4 | 大世界原点化 `ad517e5d` 已有；真实大坐标对象ID/拾取/相机证据随 F2、E/Z 复核 |
| C6/C9/C10/C11/C12/C13 | 已有天空、清漆、接触阴影、SSR能量、白炉、设备恢复接线；默认档与完整对拍归 J/E/Z，已有实现不重列 |
| C22 | 用户已裁定并入 T13；没有新 PCG 框架任务，见条件项 |
| C14/C27/C31 | 保留观察/条件触发，见下表；不计当前净开发总和 |

## 观察、条件触发与暂不实施

| ID | 条件与处置 | 触发后的首步估时 | 信心 |
|---|---|---:|---|
| I-C14 | WESL 生态观察；当前不迁第二语言 | 1–2h 核查，迁移另估 | 中 |
| I-C27 | Mesh Terrain：出现矿区/土方实际场景后核查现有 T13；不重建地形底座 | 2–4h 核查，实现另估 | 低 |
| I-C31 | CoreCLR 观察；自由 JS/TS 脚本不要求先引 .NET 运行依赖 | 1–2h 核查，宿主适配另估 | 低 |
| I-C22/T13-S4 | 已并入散布扩展；布场需求出现时先补既有零消费方的 GPU 接线/十万实例证据 | 4–8h 首刀；后续规则范围另估 | 中 |
| C24/H-write | 2026-09-30用户已将AI方案并入后续，现转入H-C7-P3；仍排在J/C/I/G/F之后，复用事务/授权/账本 | 已计P3 24–48h，不另计旧3–5人日草案 | 中低 |
| J2-B8 | 簇光照/局部阴影全架构收敛观察；先做能力与成本对照，非默认迁移 | 2–4h 设计核查 | 中 |
| R1/R5、A2/A4、U1 | 开源FSR、材质节点库、受限多轨/机位、手柄动作映射：主计划候补，不因对标补功能百科；已有timeline/camera优先复用 | 每族1–2h核查，实际新增另估 | 低 |
| H远期/T32配额 | 子智能体/压缩/原生tool_calls与token预算、多租户ONNX配额：有真实争用/使用需求后再加薄合同 | 1–2h核查，实现另估 | 低 |

明确不做：Nanite/Blueprint/Lumen 本体或全功能克隆、Havok/PhysX/Warp/Chaos 运行依赖、J6 热路径整体下沉、通用流体、赛车级轮胎、动态断裂、JT纹理/X_T key/真实PLC追索、OGC 3D Tiles、3MF导出、OpenPBR、XR、数字人、商业化AI/杂项工具面/fragment RW+atomics；第二循环/时钟/账本、外部Harness运行依赖。专业用户自由脚本属于已授权 H-C6-S1，不能被旧“代码即动作不做”挡住。

## 四路并行排程与总工期

| 范围 | 净工程投入 | 四路有效并行的排程范围 |
|---|---:|---|
| 原57行中的51项后继（含最后验收） | 295–604h / 37–76人日 | 约106–275工作小时跨度 / 14–35个8小时工作日 |
| H-C7新增AI方案4项 | 60–120h / 8–15人日 | 已扣共用H工作，按依赖插入其他组 |
| 21组旧 T 尾项核查 | 27–54h | 分散进对应文件域；复用核查证据，约2–4个并行工作日，部分可与其他任务重叠 |
| 当前可排范围合计（含AI与旧T核查） | 382–778h / 48–98人日 | 约137–354工作小时跨度 / 18–45个8小时工作日 |
| 核查后新增的 T 全包实现、全量编辑器接入批数、条件项 | 尚未锁定；不假定为0 | 对应范围冻结后增量重估；不承诺全计划固定日期 |

当前四条执行线为主线集成/工业物理、C8共享材质与完整生产链、J3双端对拍/恢复、唯一I专线；主线统一串行Cargo和共享产物，空闲线处理核查、接线或证据。用户已确认按依赖顺序推进：J/C基础→D/E与J5→G→F→其他→最终验收，I独立一路并行，待依赖时做其它I切片。**四路有效并行系数估2.2–2.8**：Cargo独占，WGSL登记与共享frame/pbrRenderer接缝顺序合并；浏览器视觉与最后冻结验收复用服务，不能把净工时机械除以4。验收总批最后。

每完成一个闭环用实际投入与剩余文件更新对应行，优先缩小低信心范围。性能/视觉目标须实测：这些估时不表示已经对标达成，也不通过反复无变化跑全量测试消耗时间。

## 证据入口

- 权威任务：`D:/Documents/bim/deliverables/research-20260928/剩余任务清单.md` 与本日 `docs/handoffs/gpt-handoff-20260930.md`。
- 当前首刀：[中断任务续接](interrupted-engine-tasks-20260930.md)、[C8](c8-dual-backend-shader-first-cut-20260930.md)、[Gate D](j3-gate-d-output-first-cut-20260930.md)、[Gate E](j3-gate-e-lifecycle-20260930.md)。Gate E CPU 已核对 `test-output/interrupted-0930/lifecycle-parity/evidence.json`，scope=`production-host-components-cpu`、passed=true；本表只排CPU首刀之外的GPU余项。
- T 包：`docs/specs/deep-engine-core-capability-development-plan-2026-09-27.md`、`docs/reports/deep-core/T00–T32-implementation.md`（实际 T00 为 baseline/fixture 文件）。这些报告为本地证据，后续提交覆盖旧状态。
- 本轮：`test-output/interrupted-0930/j2b2-tests.log`、`test-output/interrupted-0930/display-parity/evidence.json`；`git log/show` 与源码消费方是完成范围的交叉验证，不只采信完成报告。
- 第三波：[Native输出](j2-b2-native-output-first-cut-20260930.md)、[CSM边界](j2-b4-current-state-20260930.md)、[GI向量门](j2-b5-probe-production-parity-20260930.md)、[Three生产输出](c8-s2-three-output-production-20260930.md)；`output-native-contract.log`、`output-native-gpu.log`、`probe-gi-parity/evidence.json`、`c8-three-output/evidence.json` 均位于 `test-output/interrupted-0930/`。
- 最新严格J5：`test-output/j5-dual-end-gate/evidence-20260930052206.json`，9组/18腿含GPU通过、`degraded=false`；本波core/lab/examples类型及runtime freshness通过。第四波证据为 `device-recovery/evidence.json` 与 `bloom-prefilter/evidence.json`，规格为 [实际设备恢复](j3-gate-e-device-recovery-20260930.md)、[Bloom共同数学](j2-b6-current-state-20260930.md) 和 [CSM共享核](j2-b4-current-state-20260930.md)。完整runtimePurityGate仍有历史5处performance访问，`c8-runtime-purity-baseline.json`证明来源与该轮HEAD一致、C8新增错误已清；全仓source-size18既存失败已单列工程债，局部门通过不当作全仓通过。
