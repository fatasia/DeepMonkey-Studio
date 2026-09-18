# Deep Engine 后续开发任务清单

日期：2026-09-15。范围来源：[后续开发与发布方案](deep-engine-execution-plan-2026-09-15.md)。本清单用于分批开发和交接，不启动实现或发布。

主线：先让一个 Studio 场景可靠地转换、打包并在 Native 正式窗口中运行，再补二维、数据、更新和安装，最后统一验收。内核探针不重做，RT 不占主线工期。

## 当前执行状态（2026-09-16 00:45 交接更新）

下文表格保留最初任务定义，不能把其中的旧“待办”直接当作尚未实现。主线窗口当前负责 D01–D10，Deep2D 由另一窗口负责；以[恢复总账](../active-task-recovery-ledger.md)最新记录为准。

| 状态 | 范围与证据 |
|---|---|
| 已完成 | D01 生命周期拆分及回归；D02–D03 严格兼容合同、确定快照预检切片；D04–D05 归档校验、独立产物状态与历史重试。完整视觉门与 D03 降级确认放行仍单列待办 |
| 已完成 | D06 共用依赖选择、版本输入和内容寻址资源冻结、私有读取、发布事务复核、历史恢复；真实 MinIO 验证见[冻结合同](scene-client-dependencies-2026-09-15.md) |
| 已完成 | D07–D08 静态场景、GLB 和纹理编译接线；固定夹具互通已验证，未支持字段仍阻断 |
| 已完成切片 | D09 v5 将局部原点写入 schema 2 相机资源；6 个近远 Native headless 与 6 个实际 GPU smoke 通过。跨原点重载保持世界相机，正常 surface 呈现及失败旧帧恢复通过；冻结误差和范围见[坐标合同](scene-local-coordinates-2026-09-15.md) |
| 已完成切片 | D10 v5 独立真实 HTTP→服务端候选窗口→发布→Web 正式 ZIP→CLI→停止 API→同 ZIP 离线窗口；固定同一 EXE，十亿偏移 box，候选 12 帧、离线 3 帧，Vulkan 1200×800/GPU clean。独立 JsonStore/Local；见[窗口证据](scene-native-publication-evidence-2026-09-15.md) |
| 已完成切片 | 实际 Postgres/MinIO 中导入最小静态场景后，通过工作台发布 Native 版本 1；该版本私有字节→真实 Web 导出函数→CLI→正常窗口通过。浏览器 ZIP 落盘仍未捕获，不计作完整下载链验收 |
| 已完成 | D09 带坐标帧包的选择/世界测量窗口探针；origin-a/b 与旧 packet 三次 64×64 smoke 通过，实际测量与参考值分别记录。合成事件走实际 handler，不是 OS 输入或同进程连续重载；见[坐标合同](scene-local-coordinates-2026-09-15.md) |
| 本轮待办 | D01 完整视觉；D03 原定义中的降级确认后继续（当前 confirmation-required 仍拒绝）；D09 连续跨原点、法线及独立阴影容差；D10 浏览器 ZIP 落盘、系统断网及完整失败恢复。`--verify-window` 同包检查用法见[归档合同](scene-client-package-integrity-2026-09-15.md) |

这些实现切片不代表 M0/M1 已全部验收，也不扩大为任意客户场景支持。

## 1. 核对基线与范围（历史基线）

本次读取近期提交、工作区状态、[恢复总账](../active-task-recovery-ledger.md)及发布/包构建/PlayerContent 源码。HEAD 为 `cd9850b`；存在大量并行未提交改动，下面的代码判断包含工作区内容，不代表已合并或门禁通过。

| 状态 | 核对结果 | 后续处理 |
|---|---|---|
| 已完成 | 发布目标选项与 `.bimscene.zip` 导出已有代码；Native 标记 `conversionRequired: true` | 复用入口，补自动转换，不把 ZIP 标为独立客户端 |
| 已完成 | `runtimePackage/builder.ts` 已有资源/包 SHA-256、排序、校验；Native 已有 package startup、PlayerContent、LKG 路径 | 补正式发布输入及故障回归，不另建包合同和恢复系统 |
| 本轮待办 | `App.tsx` 810 行、`useAppRuntimeEffects.ts` 832 行 | 按职责拆分；行数是本次读取值，不代替门禁运行 |
| 本轮待办 | `scenePublicationActions.ts` 打包异常只 showError，随后仍返回 true，外层关闭对话框 | 分离发布版本与产物状态，支持原版本重试 |
| 本轮待办 | 导出器读取全部 applications；modelIds 为空时打包所有模型；资产匹配依赖字符串搜索 | 建立显式依赖闭包，避免漏资源与无关资源混入 |
| 本轮待办 | ZIP manifest 当前无资源 hash，renderer 仍采用 Web 策略字段 | 区分交付容器与 Native 内包；冻结目标、版本和校验语义 |
| 项目级后验收 | 固定 BIM 资产、等价 GPU timestamp、Windows 完整发布链证据不足 | 列入最终验收，不按历史测试数量自动关闭 |
| 明确排除 | Shader/Three 兼容增强专项、全插件兼容、复杂 Shader Graph、非 Windows 适配、重型 RT/路径追踪、长尾新解码器 | 保留现有实现与必要回归；发布内容兼容检查仍在本轮 |

原方案 Gate B 的 `pnpm --filter @bim-studio/deep-engine-native ...` 不适用：该目录有 Cargo.toml、没有 package.json。第 5 节给出实际入口。原方案历史测试数字只作参考，本轮没有重跑产品测试。

## 2. 里程碑与顺序

| 批次 | 可交付结果 | 任务 | 出口 |
|---|---|---|---|
| M0 发布可靠性 | 被阻断的内容不能发布；打包失败可定位并重试 | D01–D06 | 失败/重试/刷新恢复和 Three 原链路通过 |
| M1 最小 Native 交付 | 一个静态、带材质的场景从 Studio 到 Native 窗口 | D07–D10 | 无手工改包，断网可打开，快照与首帧可追溯 |
| M2 正式运行时 | 三维交互、动画、二维页面及数据共同运行 | D11–D19 | 保存→发布→下载→运行→交互→恢复全程通过 |
| M3 客户端工程化 | 版本化 portable、安装器、更新及回退 | D20–D23 | 干净 Windows 机器安装/升级/卸载通过 |
| M4 项目级后验收 | 同资产画质、性能、稳定性与统一产品验收 | D24–D28 | Gate A–D 及统一体验验收完成 |

依赖主链：D02 → D03 → D04 → D07 → D08 → D10 → D20 → D21 → D22。D01 是合并门槛；D09 在真实 BIM 交付前完成。D24 的资产准备在 M0 即开始，不能等播放器全部完成才发现没有合法样本。

暂不承诺日历工期：转换覆盖、Native 网络复用情况、样本可用性和签名环境需要在前两批确认。每项以一次聚焦会话为目标，S 为约 1–2 个文件、M 为约 3–5 个文件；目录表示落点，不代表整目录可改。预计超过 5 个文件或混入第二条独立用户路径时，先拆子任务再实现。

## 3. 开发任务

以下保留 D01–D23 及 D24 资产准备的原始任务定义；当前状态以上方执行状态和总账为准，不将已完成切片重新领取。每项完成后提交证据路径、实跑命令、退出码和未覆盖项。表中“验证”是验收要求，不是通过记录。

### M0：先修发布正确性

| ID / 大小 | 工作与可能落点 | 验收条件 | 依赖 / 验证 |
|---|---|---|---|
| D01 / M | 按生命周期、状态所有权拆分 App 与 runtime effects；`apps/web/src/App.tsx`、`hooks/useAppRuntimeEffects.ts`、相邻 hooks/views | 两个文件低于 800 行且不机械搬运；挂载/卸载及依赖行为不变；不覆盖并行改动 | 无；source-size、Web typecheck/全量测试、相关浏览器回归 |
| D02 / M | 发布内容兼容合同与检查器；`apps/web/src/delivery/`、现有 contracts | 每项含对象 ID、能力、supported/degraded/blocked、原因与替代路径；覆盖模型/材质/纹理/动画/2D/交互/数据；未知能力默认阻断 | 无；表驱动合同测试，未知类型与重复对象反例 |
| D03 / M | 发布前预检接入；`controllers/scenePublicationActions.ts`、`ScenePublicationDialog.tsx` | 对保存后的确定版本预检；blocked 时不调用 publish；degraded 展示对象与替代路径并确认，内容变化使旧结果失效 | D02；发布动作测试，检查 API 调用次数及竞态 |
| D04 / M | ZIP manifest 与 Native 内包映射；`delivery/sceneClientPackage.ts`、`packages/deep-engine/src/runtimePackage/` | target 与后端要求不混淆；版本/feature flags/资源大小与 hash/构建来源齐全；相同内容得到相同内容 hash，构建时间与 ZIP 元数据另计 | D02；确定性导出、单字节篡改、版本/后端不匹配测试 |
| D05 / M | 发布版本与产物状态分离；发布 controller、持久化适配层 | 产物 preparing/building/ready/failed/cancelled 与已发布版本独立；失败保留原因和版本；重试不再次发布也不混入新草稿 | D03–D04；5xx、取消、重复点击、并发发布、刷新恢复、迟到结果测试 |
| D06 / M | 资源依赖闭包；`delivery/sceneClientPackage.ts`、相邻导出模块 | 只包含场景关联页面/模型/纹理/环境及数据依赖；空引用不回退全项目；缺失项带路径阻断且跨项目引用拒绝 | D04；嵌套依赖、循环引用、未关联页面、相同 URL、越权资源夹具 |

检查点 M0：D01–D03 后先回归发布入口；D04–D06 后覆盖发布成功但打包失败、重新进入页面重试、Three WebView 下载与旧包兼容。未通过不得扩大转换范围。

### M1：最小 Native 场景交付

| ID / 大小 | 工作与可能落点 | 验收条件 | 依赖 / 验证 |
|---|---|---|---|
| D07 / M | 静态 SceneSnapshot 转换适配器；Web delivery → 现有 RenderPacket/runtimePackage builder | 模型/实例 ID、层级变换、可见性、相机确定映射；不依赖编辑器临时 GPU 状态；未支持的作者能力报对象级阻断 | D04、D06；一个带实例的最小场景 golden、乱序输入、空场景 |
| D08 / M | GLB 与纹理资源转换接线；现有 `gltf/`、资源导出适配器 | 复用解码器，保留材质槽/色彩空间/采样与 mip 策略；纹理与环境图自包含；超预算及不支持压缩格式给出对象与原因 | D07；合法/损坏 GLB、多材质、纹理缺失和大小边界 |
| D09 / M | 大坐标合同与局部原点接线；转换适配器、Native 场景/相机边界 | 世界坐标与渲染坐标可逆；切换原点不改变对象 ID；预先冻结测量/拾取/阴影/相机容差，禁止事后放宽 | D07；远离原点与近原点同场景数值对照、跨原点运动 |
| D10 / M | 导出产物接正式 Native 启动；`runtime_package_startup.rs`、`player_content.rs`、打包适配器 | Studio 导出后无手工编辑即可打开窗口；校验完成才分配运行资源；缺资源/坏包/不兼容版本明确拒绝 | D08；真实窗口首帧、断网启动、篡改包与现有 CLI 回归 |

检查点 M1：D07–D08 先验证转换与资源；D09–D10 再使用同一已保存快照完成发布与真实首帧比较。此时只允许标记“静态场景支持”，不能提前宣称动画和数据生产可用。

### M2：逐条接入正式运行时

| ID / 大小 | 工作与可能落点 | 验收条件 | 依赖 / 验证 |
|---|---|---|---|
| D11 / M | 相机/选择任务流；Native `events.rs`、`player_state.rs` 及现有输入模块 | 鼠标与键盘控制有焦点规则；拾取返回作者对象 ID 并驱动高亮；空点/隐藏对象不误选 | D09–D10；真实窗口操作、极端缩放、焦点切换与命中反例 |
| D12 / M | 测量/剖切任务流；复用 Native 相关模块 | 单位与局部原点一致；剖切同时影响显示和可拾取性；清空/重载不残留状态 | D11；已知尺寸样本、剖切边界、刷新恢复与截图 |
| D13 / M | 动画端到端；现有 animation/gltf 与 Native frame/update 边界 | 先交付 TRS 播放/暂停/跳转；morph/skinning 分别核对已有运行能力，未接通即 blocked；时间与场景 revision 一致 | D10；固定时刻姿态、循环边界、切场景及取消；变形接线超出 M 时单独拆卡 |
| D14 / M | 透明/光照/场景更新一致性；Native renderer、资源缓存 | 保留作者透明/环境/灯光/阴影语义；更新原子生效且旧资源安全释放；Web 与 Native 差异逐项登记 | D08、D10；透明排序、共享材质、迟到上传、设备重建对照 |
| D15 / M | 二维页面导出并显示；现有 Deep2D 包构建与 PlayerContent | 保存页面转换为 retained UI 内容；中文/图表/布局进入正式窗口；页面切换不遗留旧资源 | D06、D10；多页面固定夹具、空页面、DPI 与截图 |
| D16 / M | 二维事件与三维联动；现有 Deep2D hit/event/IME 接口 | 命中坐标考虑 DPI 与缩放；图表选区驱动真实三维选择；焦点/输入法/切页事件不串页 | D11、D15；真实点击与中文输入、边缘命中、快速切页 |
| D17 / M | 运行时配置及安全注入；已有数据描述与 Native 配置适配层 | 连接元数据与凭据分离；错误/日志/产物不泄露敏感值；健康检查能定位待配置连接，不修改 Studio 存储拓扑 | D02、D06；凭据扫描、无配置、权限不足、配置版本不符 |
| D18 / M | `sim:` 离线数据驱动二维/三维；现有仿真与 binding 合同 | 固定种子结果可复现；同一数据 revision 驱动两侧；切场景取消订阅、离线不伪装实时外部数据 | D15、D17；离线完整流、坏值、空数据、订阅释放 |
| D19 / M | 首个外部 HTTP 数据连接；Native 网络适配与绑定 | 超时/取消/退避重连/过期数据状态明确；断网仍可按策略浏览并显示最后更新时间；连接删除后不继续拉取 | D17–D18；故障注入 401/5xx/超时/乱序/断网重连。WebSocket、PostgreSQL 分别独立子卡，依本节连接矩阵启用 |

检查点 M2：D11–D12 验交互；D13–D14 验三维更新；D15–D16 验二维联动；D17–D19 验数据与离线。每个检查点只提升已经取得正式路径证据的兼容项。

连接矩阵的建议执行策略：`sim:` 与 HTTP 作为首批交付；WebSocket、PostgreSQL 保留计划范围，分别完成适配和故障测试后启用。在对应任务完成前发布预检必须 blocked，不能借“部署后配置”承诺尚未实现的适配器。PostgreSQL 优先核查既有受控服务接口是否可复用，再决定直连；不把数据库密钥写入包，也不改变 postgres+minio 权威拓扑。

### M3：Windows 客户端工程化

| ID / 大小 | 工作与可能落点 | 验收条件 | 依赖 / 验证 |
|---|---|---|---|
| D20 / M | 场景版 portable 构建；现有 build-windows/package-windows-portable 脚本 | 正式 EXE 与指定包版本绑定；无 WebView 的干净 Windows x64 可离线运行；manifest/hash/第三方声明齐全 | D10、D17；构建、解压启动、缺运行依赖、非 ASCII/空格路径 |
| D21 / M | 更新事务与 LKG 接线；现有 asset_package、runtime_lkg 模块 | 下载校验后原子切换，成功 present 才提升 LKG；断电/坏包回到有效版本；缓存有配额与清理规则 | D20；中断更新、磁盘满、写权限不足、并发启动与坏 LKG |
| D22 / M | 安装器与签名；Windows 构建脚本、发布配置 | 安装/升级/卸载验证完成且不误删用户数据；签名校验与 SHA-256 一致；缺签名证书不能记正式发行完成 | D20–D21；干净机器与已安装旧版两套验证，工具选择在执行前核对 |
| D23 / M | 页面产物信息及构建交接；发布 UI/controller、现有服务端产物路径 | 显示版本/目标/状态/hash/下载/资源及待配置连接数；失败可操作重试；编辑器不切换运行时且能另发 Three 目标 | D05、D20；下载权限/过期链接/刷新/并发版本/双主题窄窗。如缺构建服务，先单独拆出任务协议与执行器，禁止浏览器伪造 EXE |

检查点 M3：D20–D21 验 portable 和故障恢复；D22–D23 验安装与页面交接。开发者本机可运行不能替代干净机器验证。签名、公开分发和外部发布环境在执行时核实，不在规划阶段操作。

## 4. 项目级后验收任务

| ID | 工作 | 验收条件与证据 | 依赖 |
|---|---|---|---|
| D24 | 固定工厂/电站/仓储三套 BIM 夹具；资产准备提前 | 每套至少 50 万三角形、200 实例、真实纹理与多材质；记录来源/再分发权/hash/尺度/统计；几何覆盖有基准 | 无；无合法资产则记录外部依赖，不用合成夹具顶替 |
| D25 | Native 正式场景性能接线；按 LOD/剔除、流式/驻留、质量档拆子卡 | 复用已有 GPU 模块；无漏绘且预算回收有效；每张子卡有开启/关闭对照，只有实测收益才默认开启 | D09–D14、D24 |
| D26 | Web/Native 视觉合同与两轮截图复检 | 同资产/视角/曝光/分辨率，按几何/材质/透明/阴影/后处理/文字/布局输出差异；阈值在跑结果前冻结；接受差异有原因与能力状态 | D12–D16、D24 |
| D27 | 等价 GPU/竞品基准 | timestamp 与 host 时间分账，记录驱动/API/质量/轨迹；p50/p95/p99、显存/可见量/漏绘齐全；Unity 90% 的指标和聚合方法先冻结，不比较不等价负载 | D25–D26；Unity Vulkan 缺 shader 时修基准构建或标记不可比 |
| D28 | 统一交付验收及修复 | 全用户流、E2E/视觉/性能/可访问性/20 分钟长稳/故障注入/发布回滚统一执行；全仓文件与函数体量扫描；发现问题按根因同族修复并复跑 | D19 含获准连接子卡、D22–D23、D25–D27 |

D25–D28 是验收工作包，不是单次编码卡。执行前每包按一个失败域拆为 S/M 修复卡，但最终交付门作为整体通过，不能用某个页面或探针通过代替。保留取消 WebGPU 8 小时 soak 的既有决定。

视觉验收执行 `design-taste-digitaltwin`：Design Read → `base.css` 令牌先行 → 实现 → 至少两轮实际截图与修复 → 同族排查 → 十维逐项评分。对标分别采用山海鲸氛围、ThingJS 动线、FVS 布局、Unity 画质、西门子语义；维度为布局、令牌、排版、状态、动效、3D、信息、反馈、响应式/主题、文案，各项至少 9/10。测双主题与相关 1920/1280/980/800/480 宽度，并保留既有产品门的视口覆盖。不得为视觉默认值覆盖作者保存的环境与画质策略。

本规划不包含视觉实现，未截图、未自评分。以上是执行门槛，不是已经达到 Kimi-95 或竞品性能门槛的声明。

## 4A. 关键架构决策：3D 可复用，2D 分层交付

“3D 直接兼容”只能成立在资产和语义已落入 `SceneSnapshot/RenderPacket` 的范围内；不能把 Three 场景对象或 WebView DOM 直接搬进 Native。正确做法是：3D 走确定性快照转换，2D 看板走独立的跨运行时内容合同。

### 2D 三档策略

| 档位 | 适用内容 | 实现方式 | 发布状态 |
|---|---|---|---|
| A：原生 Deep2D | 文本、形状、图片、表格、基础 KPI、折线/柱状/饼图、筛选器、页面布局 | 编辑器保存为受限 `DashboardDocument v1`（节点树 + 样式 token + 数据绑定 + 命中区域），编译为现有 Deep2D retained commands；Native 绘制、命中和事件 | `supported`，首个生产范围 |
| B：兼容组件 | 自定义图表、复杂 SVG、富文本、部分动画、第三方组件 | 建立组件适配器 ABI：输入 props/schema、输出静态/增量 display list、事件映射和降级说明；每个组件单独 golden 与版本 | `supported` 或 `degraded`，按组件放行 |
| C：WebView 兼容 | React/HTML/CSS、插件、iframe、任意脚本、需要浏览器 API 的组件 | 页面作为独立 WebView surface，与 Native 3D 通过消息合同通信；不把 DOM 假装成 Native 2D | `webview-only`；Deep Native 目标遇到此项必须阻断或明确要求 Three WebView |

### 2D 数据与交互边界

1. 看板文档只保存结构、样式、绑定和事件意图，不保存 React 状态、函数体、任意脚本或凭据。
2. 数据绑定统一为 `dataset → transform → widget property`；`sim:` 可随包运行，外部连接由 Native 配置注入。每次刷新携带 revision、时间戳和错误状态。
3. 事件统一为 `pointer/key → hitId → command`，命令只能更新页面状态、筛选器、相机/选择/剖切等白名单动作；禁止组件直接调用宿主任意 API。
4. 字体、图标、图片和图表数据作为带 hash 的资源；缺字体、超出文本能力或不支持图表类型必须在发布预检阶段列出对象级 `degraded/blocked`。
5. 编辑器继续用 React/WebView 作为作者环境；保存时生成 `DashboardDocument v1`，Native 只消费编译产物。这样作者体验和播放性能解耦，也保留 Three WebView 的完整兼容后路。

### 为什么不采用“全部转 Canvas”

全量截图或 Canvas 化只能得到不可交互的画面，无法可靠实现数据刷新、命中测试、无障碍、DPI、动画和三维联动；全量复刻 React/CSS 又等于维护第二套浏览器。A/B/C 三档把高频工业看板收敛为可验证原生子集，把长尾能力留在 WebView，并让每个降级可见、可测试、可回退。

### 对任务表的调整

- D15 改为先冻结 `DashboardDocument v1` 与组件能力注册表，再接 Deep2D 编译器；不是直接读取 `applications.json` 绘制。
- D16 的二维事件测试必须覆盖 `hitId/command` 合同和三维联动白名单。
- D02、D03 的兼容预检增加 `webview-only` 状态；选择 Deep Native 时 C 档直接阻断，选择 Three WebView 时保留原页面。
- D24–D26 的视觉基准增加同一看板在编辑器、Deep2D Native、Three WebView 三处截图；比较布局、文字、图表数值和 DPI，不把 Canvas 像素截图当作组件交互通过。

## 5. 验证入口与证据格式

以下根脚本已从 package.json 核对存在。先运行各任务相关 focused 测试，再执行所属检查点；脚本存在不意味着本轮已运行。

```powershell
# 仓库根目录
pnpm quality:source-size
pnpm gate:repository
pnpm gate:deep-engine-editor
pnpm --filter @bim-studio/web test -- --run
pnpm --filter @bim-studio/web build
pnpm gate:deep-p0:native
```

Native 定向测试使用真实 Cargo 入口，例如：

```powershell
cargo test --manifest-path packages/deep-engine-native/Cargo.toml --locked --test runtime_package_contract
cargo test --manifest-path packages/deep-engine-native/Cargo.toml --locked --test runtime_package_startup_recovery
```

portable 使用现有 `packages/deep-engine-native/scripts/build-windows.ps1`、`package-windows-portable.ps1`、`portable-smoke.ps1`；执行前读取参数及输出目录，不凭空添加 `verify:portable` pnpm 脚本。ignored GPU 测试须按各测试的实际设备条件单独执行，普通 cargo test 通过不等于真 GPU 通过。

每项证据记录：任务 ID、commit/工作区差异标识、输入 snapshot/package/asset hash、命令与退出码、测试结果及 skipped/ignored、实际设备与计时来源、截图或报告路径、已知限制。产物仅本地留档，禁止提交运行日志、凭据、客户模型和登录截图。

## 6. 领取规则与下一步

原始批次为 D01/D02/D24 → D03 → D04–D06 → D07–D10；该顺序只保留依赖关系，当前接手从未关闭的验收项继续。每次领取前重新看 git status、近期 diff、总账和当前清单；发现并行会话已有实现，转为复用/验证，不重新建设。Deep2D 以其完整剩余表为准，D15–D19 交叉能力共用实现，D24–D28 项目级后验收继续保留。

暂不启动多个会话。以后并行时，发布线独占 controller/dialog，转换线独占导出适配器，Native 线独占 player/update，证据线只维护夹具和报告；共享合同先定版，GPU 基准串行运行，避免负载干扰。

提交与推送：按用户 2026-09-15 授权自主执行，无需逐次询问；仍须完成相关检查、审查暂存 diff、逐文件暂存和核对远端更新。提交围绕一个可回退切片，文档与兼容状态同步；失败日志留在本地产物目录，不进入 Git。不得用 `git add .` 将混合工作区整批纳入本轮提交，不强推，也不为了通过检查删减治理规则。

尚需在执行中确认：合法 BIM 样本、首批客户场景必须支持的动画/连接类型、运行时构建所在机器与产物存储接口、代码签名证书。上述未知不阻塞 M0；确认结果回填本清单与恢复总账，不能静默减项。
