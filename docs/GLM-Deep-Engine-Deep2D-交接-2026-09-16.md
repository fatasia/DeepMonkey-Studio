# GLM 夜班交接:Deep Engine + Deep2D + 两份新计划 · 2026-09-16 09:00

> 供下一个会话(GPT/Codex)接手。本文件由 GLM 夜班(2026-09-16 00:45–09:00)产出,承接自
> [Deep-Engine-Deep2D 统一交接 00:45](C:/Users/rain/AppData/Local/Temp/Deep-Engine-Deep2D-handoff-2026-09-16-0045.md)。
> 工作区 `D:/Documents/bim/bim-studio`,分支 `dev-studio`,HEAD `e75d797`。**本夜未 commit/push**,
> 全部改动在工作树中,与并行会话的历史改动共存;接手先读 `AGENTS.md`、总账尾部四节、
> `git log/status`,再领取任务,不得 reset/clean/stash 未知改动。

## Goal of next session

两条主线不变:①Deep2D 45 项表推进(本夜完成/实质推进 18 行:P0-01 第一批、P0-02、P1-01/02 第一批/03 第一批/04/05 第一批/06 评估/07 测量结论/08 第一批/10/11/12/13 第一批/14/15/16 两批/17)+ 三维主线 D11–D23;②两份新计划
[industrial-3d-format-work-plan](industrial-3d-format-work-plan-2026-09-16.md)(PLAN/FMT/PC/TILE/RHINO/SW/EXT)
与 [deep-engine-surpass-strategy](deep-engine-surpass-strategy-2026-09-16.md)(十二领域/S0–S4)已开工首批,继续按各自阶段表执行。
用户排期口径:**Deep2D/主线优先,两份新计划排后,但仍要按切片出真实进展**。

### 接手清单（本会话逐条回填）

- [x] **PLAN-01/02 第一批证据锁定**：完成 `docs/specs/industrial-format-plan01-02-lock-2026-09-16.md`；8 个已下载依赖工件、6 个单工件样本和 463 个解包文件哈希复核一致。候选库仍未试编译，PDAL/3D Tiles/openNURBS 与真实格式覆盖保留原有阻断。
- [x] **P1-14 pointer_move 宿主接线**：axis tooltip 先按 screen-X 聚合最近可见 datum，bar-only 回退命中矩形，复用同一 `Hover` action，固定 16px 逻辑容差；`chart_axis_pick` 12、`chart_runtime` 5、`chart_tooltip_content` 5 全绿。
- [x] **P1-14 真实 GPU 冒烟复核**：`deep-engine-native.exe --smoke-chart packages/deep-engine/fixtures/chart-ir-v1.json` 在 NVIDIA GeForce RTX 4060 Laptop GPU / Vulkan 上完成初始、缩放、选中、tooltip、清除序列；GPU scopes/callbacks clean，窗口帧提交成功。
- [x] **P1-02 删除检测子切片**：成功准备整帧后按 display command id 清理缓存孤儿条目，新增 `deletions` 诊断计数；失败候选不触发清理，失效回归 9 项全绿。
- [x] **P1-02 第二批（epoch/相机依赖图）**：条目携带 `EntryWitness{camera_scale_bits, resource_epoch}`，新增 `set_resource_epoch`/`set_camera_scale`；归因序 相机→epoch→结构→clip→resource→风格。**并修掉一个真实缺陷**：见证取显式相机值而细分仍用 `scale_factor`，导致「见证 2.0 / 几何 1.0」条目被后续帧永久命中（实测 387 vs 591 顶点）。数据 revision/z 序/hitId 刻意不进图并有测试锁定。新增 7 项测试；[spec](specs/deep2d-path-cache-dependency-graph-2026-09-16.md)。
- [x] **P1-02 剩余：宿主侧接线**（接手会话完成）：`Deep2dFrameContext` + `deep2d_frame_context()`（letterbox **实际比值**，非标称 DPI）；chart update / 换页（目标页号）/ 换包（候选 epoch）三条生产路径全部接线；新增 `painter::effective_scale()` 保证整帧单一缩放（path 细分、文字/图片、clip、stroke 容差同源），未接线时保持第一批行为。5 项测试锁定「DPI 真的进了细分几何」。见 [spec](specs/deep2d-host-wiring-and-transfer-accounting-2026-09-16.md)。
- [x] **P1-02 剩余：vertex transfer 侧记账**（接手会话完成）：`VertexTransferReasons` 六分类 + 纯函数判定顺序 + 累计口径；与 path cache miss 账构成两层可观测（细分为什么重算 / 顶点为什么重传）。2 项测试。
- [x] **P1-05 第二批：数据否决改造**（接手会话完成评估）：呈现层克隆 0.0149ms（占 prepare 2.09ms 约 0.7%），真正成本是首次物化 0.366ms 且承载已锁定的定版语义；改造需动公共消费面，收益不足，不改造并记录数据。
- [x] **P1-08 第二批：数据否决改造**（接手会话完成评估）：区域上传需上游脏矩形通道，实测 chart atlas 总量约 63KB，整块重传微秒级，收益不可测量；否决跨层通道，待 MB 级重估。
- [x] **P1-09：测量与判据**（接手会话完成）：IBL 27KB / 紧凑阴影 64KB 可忽略；**前向目标 44 B/px（1280x720 ≈ 40MB）是唯一大头**，已确认与 Deep2d 零像素依赖。落地 `planeless`/`skip_forward_targets` 判据 + `ContentProfileReport` 启动报告，5 项测试。**未改帧路径**，跳过实施属独立切片。
- [x] **P1-13 剩余：字节预算 + 静默窗口**（接手会话完成）：字节预算与条数上限共同生效、单条超预算不入缓存；**口径修订**——同步 Transport 无在途窗口，原「宿主 deadline」改为静默窗口（`idle_deadline_ms`+`last_activity`+`poll_idle_deadline`）。data_source 11→17 项测试。
- [x] **P1-15 剩余：运行期 emphasis 与 ChartAction 对齐**（接手会话完成）：`ChartAction::Highlight`/`Downplay` 对齐 TS/ECharts `dispatchAction`；初始 highlight/downplay 改为经同一 `apply` 派发，消除双轨。2 项测试。
- [x] **P1-16 第三批：真实窗口键盘 smoke**（接手会话完成）：`--smoke-chart-keyboard` 复用生产入口 `chart_key`，6 阶段 **RTX 4060 Laptop/Vulkan 真机全绿**（命令数 17→18→18→18→17→16→17），每步 clean。补上此前「窗口键盘 smoke 未跑」的缺口。
- [ ] **P1-03 数据通道接线**：`chunked_rows` 接入实际数据窗口（存储层已完成，未接 ChartIR 是任务明示）。
- [ ] **P1-13 剩余**：HTTP Transport 真实绑定（受控 HTTP/订阅/异步握手/TLS）。
- [ ] **P1-16 剩余**：OS 屏幕阅读器桥（焦点环与语义树已就绪）。
- [ ] **P1-18–23 / P2 / P3 / V**：按总表顺序推进，未验证项不得标记完成。**P1-09 帧路径跳过**（前向目标）为已测量立项项，需真实窗口像素对比与双主题闭环。

## State of play

### 本夜已完成(9 切片 + 2 审计 + 1 服务恢复,全部有证据)

| 切片 | 交付物与证据 | 验证 |
| --- | --- | --- |
| **P0-02 动态 ChartIR 入包** | 运行包 v4 chart 时代合同双侧落地:`chart-runtime`/`chart-sim-runtime` 资源种类与入口键、信封 id/revision 绑定、chart 与 deep2d 入口互斥、camera 自 v4 可选;`buildChartRuntimePackage`;`from_package` 经 `player_content_chart_entry.rs` 重建 ChartRuntime/sim 宿主/展示列表;CLI 零新增。TS→Native golden 双夹具(dynamic `99e0beb9…`/static `82fdf617…`) | deep-engine 2821 测试+Native golden 5 项+bin 2 项;真实 GPU 双冒烟(sim 3 帧固定时钟+交互序列,恢复检查点)。[spec](specs/deep2d-chart-package-2026-09-16.md) |
| **P1-04 行统计缓存** | `ChartRows` 升级为行+惰性统计缓存;DerefMut 即失效点;semantic_validation 三处扫描改查询,语义逐一对齐 | 冷/热/失效/坏数据/边界 3 项测试;release 热路径 median 4.7761ms→**0.279/0.3816ms**(13~17 倍)。[spec](specs/deep2d-row-stats-cache-2026-09-16.md) |
| **P0-01 第一批:Dashboard 内容 lowering** | 全组件容器铬层(背景色/透明度与 Web 运行时逐值一致)、形状内描边、逐对象 reasons/deferredFields/contentCompiled、capabilityReport 增 coverage 计数;pass 升版 dashboard-widget-content v2;`publicationReady` 仍 false(诚实) | compileDashboardContent.test 12 项+delivery 文件夹 371 项;tsc 通过;golden 再生(`603511a1…`)+Native 断言同步。[spec](specs/deep2d-dashboard-widget-content-2026-09-16.md) |
| **P1-01 全局 Epoch**(子代理) | `chart/epoch.rs`:五元组+同源 data_revision+ChartEpochCommit 事务(publish 后纯赋值);update/change_legend_page 事务化;from_package 以 (packageId,packageHash) 初始化 document_revision | chart_epoch 7 项(+12 项既有同跑);失败全保持有测试证明。[spec](specs/deep2d-epoch-and-text-fit-2026-09-16.md) |
| **P1-17 测量式文字截断**(主线程) | rasterizer `measure()`(自然单行宽度)+ `fit_ellipsis`(二分实测省略,图例图标前缀实测占宽)+ tooltip 按行整体实测 | chart_text_fit 3 项+tooltip/legend 回归。[同上 spec] |
| **P1-03 混合值分块存储**(主线程) | `chart/chunked_rows.rs`:行块 Arc 共享/整块窗口淘汰/部分边界仅 COW 首块/预算 fail-closed/null 与中文语义保留;未接 ChartIR(任务明示) | 5 项测试含引用计数证明。[spec](specs/deep2d-chunked-rows-and-axis-pick-2026-09-16.md) |
| **P1-14 Axis/线段拾取**(子代理) | XInverter 三态反解×zoom;nearest_x 跨 dataset 聚合(前景优先/row 身份不变);线段补空隙、顶点绝对优先、系列级命中合同一致 | chart_axis_pick 12+chart_line_pick 7;**顺带解决了此前 chart_runtime.rs 的基线红项**。[同上 spec] |
| **P1-12 sim 窗口与失败恢复**(子代理) | `pump()` 唯一推进+`wake_delay()` 纯调度数学;`--smoke-chart-sim` 升级 8 阶段注入(含 renderer 失败注入游标不动、恢复续跑无缺口) | chart_simulation_lifecycle 5 项+既有 9 项;真实 GPU 冒烟走通 8 阶段 |
| **P1-15 单行持久强调**(子代理) | MarkerKind 强度合成(Selected>Emphasis>Hover);隐藏保留状态;窗口淘汰+行身份迁移;row 覆盖系列/scoped downplay;零新 action(走 authored Highlight/Downplay data_index 通道) | chart_emphasis_markers 5+chart_emphasis 3;state_render 断言最小收窄(已披露,复核接受) |
| **doc1 PLAN-03 合同骨架**(子代理) | `packages/contracts/src/formatImportContracts.ts`(255 行):SourceBundleRecord/ImportRecipe/CoordinateFrameV1/QualityReport 四类 v1 合同+运行时断言;坐标帧与 sceneLocalCoordinates 逐字段对齐并锁定网格约束;QualityReport 算术校验(dropped≤input、rule=none 不得改三角数);头注释声明「枚举值不代表格式已支持」 | contracts 286 测试通过(含新增 10 项)+tsc 通过;纯合同,不执行转换 |
| **doc1 PLAN-04 审计** | [industrial-format-plan04-queue-audit](specs/industrial-format-plan04-queue-audit-2026-09-16.md):确认 **ConversionQueue(legacy)与 ConversionTaskService(新)双轨并存、任务 ID 空间不同**,统一方案与迁移建议已写;实施需用户批准(跨模块) | 文档交付 |
| **doc2 README 漂移清理** | `packages/deep-engine/README.md`(“不接入正式应用”/“不代表已有 native 图表 renderer”两条过时声明已改为事实)与 `packages/deep-engine-native/README.md`(deep2d painter 的 dash/clip/round cap/text/image“有意拒绝”与“尚未完成”清单已按当前代码更正) | repository gate 通过 |
| **P1-05 chunk/view ABI 第一批**(子代理) | 帧内存按系列三 Arc chunk(geometry/commands/resources)+ OnceLock 惰性扁平视图;线格式与消费方签名不变。诚实修正:克隆本就 O(1)(frame 已是 Arc),真实收益在增量更新路径——命令内存 8 份→1 份,prepare median 2.41→2.09ms(-13%);ptr_eq/z 序逐值/失败时机等价证明;Send/Sync 保持 | chart 全家族 26 目标+lib 119+4 项新测试。[spec](specs/deep2d-frame-chunks-and-gpu-transfer-2026-09-16.md) |
| **P1-06 GPU 传输策略评估**(子代理) | 三场景实测(冷启动/局部 1 点/全量):分配 0.7–1.0µs 占 stage 0.1–0.2%——**数据否决 ring/arena**;「发布即不可变」为刻意设计(经 cache 复用会缓存投毒,复用交接点在禁区模块)。落地 `buffer_allocations` 可观测字段+三场景字节预算断言+逐像素旧帧保护+release 计时基准 | release/debug GPU 多轮全绿,像素一致断言不变;持久分配器立项数据已备。[同上 spec] |
| **P1-07 细分缓存测量**(子代理) | 计数分配器实测:payload 记账低估真实堆 ~6%;**证实缓存顶点与 vertex shadow 全量重复驻留**(夹具 1.12MB,最坏 ~8MiB),Arc 化需跨禁区立项;冷启动拆解:可归因缓存写入 0.056ms,其余在噪声底;仅实施 clips 单次收集。"不做"项均有测量依据 | deep2d_path_cache_memory/cold_bench 新测试+lib 131;[spec](specs/deep2d-frame-chunks-and-gpu-transfer-2026-09-16.md) 未含此节,见总账 |
| **P1-13 宿主数据源状态机 第一批**(子代理) | `chart/data_source.rs` 离线优先状态机(Disconnected/Connecting/Connected/Retrying/Closed,注入时钟+Transport trait 零真实 IO/零新 crate);迟到/重复/串源拒绝(串源优先)、有界环形离线缓存+水位续传、取消终态幂等、凭据类型上不出现;CAS 适配对接真 ChartRuntime | data_source 11 项测试+lib 130;HTTP 绑定/宿主 deadline/字节预算留后续(总账) |
| **P1-10 端到端性能基线**(子代理) | `tests/chart_e2e_perf.rs`(299 行):真实 Win32+Vulkan 1280×720、8×8192,七场景×30 采样 P50/P95/P99(初始 16.4/静态 0.21/局部 8.7/全量 27.1/resize 43.3/图例 4.7/tooltip 4.9ms,p50);GPU timestamp 实测+降级分支、present 延迟、上传字节(零重传=内容寻址健康)、显存估计口径注明;单机单卡,无跨设备/FPS 结论 | `--ignored` 真实窗口跑通,机器可读 JSON 输出 |
| **P1-08 文字栅格缓存第一批**(子代理) | `GlyphRasterCache`(双预算 4096 条/8MB LRU、Arc 值、错误不入缓存下次重试、resource_revision)+ `GlyphAtlasBook.place_text` 接真实栅格产物;同 key 免重栅格、size 变化全重建、逐出/clear 不污染在用值 | 7 项测试+lib 131;GPU 区域上传留 deep2d_gpu 车道 |
| **P1-16 键盘无障碍第一批**(子代理) | `native_ui/chart_a11y.rs` 键盘状态机(Tab 聚焦图例/方向键移动/Enter·Space 激活/Esc 释放/±与 PgUp·Dn zoom,与标注草稿、section 剖切模态互锁);Toggle/Zoom 走与鼠标完全相同 dispatch,**双图对拍逐字节一致**;语义树+a11y 事件串 | 键盘 5+语义 3 项测试;诚实缺口:焦点环画进 chart 像素需渲染层追加点(按 STOP 未动)、无 OS 屏幕阅读器桥、真实窗口键盘 smoke 未跑 |
| **P1-02 失效原因记账第一批**(子代理) | `painter_cache.rs`(147→233 行):miss 原因五分类(structure/clip/resource/style/evicted,固定判定顺序注释化)+有界逐出记忆+`with_limits` 构造入口;命中行为逐字节等价 | 8 项子图失效证明测试(改 A 只 miss A);deep2d_path_cache 家族全绿;JSON 单行输出 |
| **P1-16 第二批:焦点环入像素**(主线程) | `append_legend` 按 `focused_item` 在焦点项外扩 3px 画 accent 描边环(页级稳定 id,越界静默跳过);焦点移动/释放触发图例重呈现使环跟随;present_chart 增加 `legend_focus` 参数(包加载/from_chart 传 None) | chart_legend 新增焦点环测试+全家族回归;真实窗口键盘 smoke 仍缺(P1-16 遗留) |
| **PLAN-01/02 第一批锁定** | `data/external-assets/industrial-format-plan/`(不入 git):七方向中 6+ 方向的 SHA256SUMS、`corpus-manifest.json`(13 键,v1 含 hash 政策与范围声明)、dependencies/ 与 samples/ 部分下载；锁定报告已完成：`docs/specs/industrial-format-plan01-02-lock-2026-09-16.md`。候选未试编译，生产支持仍阻断。 | 8 个依赖工件+6 个单工件样本哈希匹配；7 份校验表 463 文件匹配 |
| **服务事故恢复** | supervisor 51408 夜间退出(原因无法与旧 EBUSY 日志区分,如实记录);`pnpm studio start` 按原 PG/MinIO 配置恢复,API 4100/Web 5173 健康。**EBUSY 触发器仍活着**:生成 PNG 直写 `apps/web/public/docs-assets/generated/` 会再次打挂 Web watcher,接手应把生成物移出 watch 范围 | 总账「夜班服务事故与恢复」节 |

### 本夜已验证门禁(全部为合并态最新数字)

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| Native 全套(中间合并态存档) | 756→760→773 通过,全程 0 失败 | `p004/p005/p006-native-full.log` |
| Native 全套(P1-10/11 合并态) | 802 通过 / 0 失败 / 59 GPU 忽略 | `test-output/p007-native-final.log` |
| Native 全套(P1-08/16 合并态) | 817 通过 / 0 失败 / 59 GPU 忽略 | `test-output/p008-native-final.log` |
| Native 全套(**GLM 夜班最终交付态**) | 826 通过 / 0 失败 / 59 GPU 忽略(113 目标,check 0 warning) | `test-output/p009-native-final.log` |
| Native 全套(**接手会话合并态**) | **862 通过 / 0 失败 / 60 GPU 忽略**(净增 36 项;check 0 warning) | 本轮运行 |
| Web 全量 | 570 文件 / 3297 测试通过 | `test-output/p003-web-full.log` |
| API 全量 | 954 通过 | `test-output/p003-api-full.log` |
| deep-engine 包 vitest | 341 文件全过 | `test-output/p002-deep-engine-full.log` |
| repository gate / 800 行门禁 | 通过 / 4340 文件通过 | 本轮复核 |
| 真实 GPU 静态包(接手会话) | initial/zoom/reset/tooltip/clear 全过,scopes/callbacks clean | 本轮运行 |
| 真实 GPU sim 包(接手会话) | 8 阶段(backlog 追赶/GPU 失败恢复/取消)全过,clean | 本轮运行 |
| 真实 GPU 键盘 smoke(接手会话新增) | 6 阶段全绿,clean | `--smoke-chart-keyboard` |
| 真实 GPU 冒烟 EXE SHA(GLM 夜班最终态) | `790b1df992acecc96166472f1c0cb29310ab25029e4dbe3adc4251e526e94fd0` | `test-output/p005-smoke-*.log` |

**未验证/未覆盖(诚实条款)**:P1-01 epoch 的 GPU 端到端失败注入、P1-12 真实换包窗口注入、P1-15 TS dispatch 通道(GLM 遗留;**运行期 emphasis 已由接手会话补齐**)、P1-02 宿主接线的**真实换包窗口注入**仍未跑、P1-09 前向目标跳过未实施、本夜与接手会话全部改动未做浏览器交互遍历与双主题视觉闭环(V-02 未达)、全部未 commit。

### 并行会话残留(非本夜引入,未代改)

- deep-engine 包级 300 行门禁与 runtime purity 门禁失败,全部命中并行在途文件(`browserImageDecoder.ts` OffscreenCanvas、`chart_render.rs` 748 行等 13 项)。
- 共享树中 `renderer/`、`native_ui/`、`deep2d_gpu.rs` 等大量 M/?? 文件属其他会话;本夜所有子代理均按文件所有权清单工作,越权一处(chart_state_render.rs 断言收窄)已披露并复核接受。

## 本轮待办:接手顺序建议

1. **先复核本夜 9 切片**(总账四节+四份 spec),确认无理解偏差后再动新任务;especially:epoch 事务的 update() 顺序语义、chunked_rows 的预算语义(C05 相反,有意为之)。
2. **PLAN-01/02 后续**:第一批 lock 报告已完成；继续按许可边界补样本与 PLAN-02 Windows 离线试构建/体量记录。
3. **Deep2D 剩余约 28 行**:P1-02 第二批(epoch/字体/相机进依赖图、vertex transfer 记账)、P1-05 第二批(GPU staging 消费 chunk)、P1-07 后续(shadow Arc 化立项)、P1-08 第二批(GPU 区域上传)、P1-09/16 第三批(OS 阅读器桥/窗口键盘 smoke)、P1-18~23 文本行为族、P2-01~04、P3-01~05、V-01~05;P0-01 后续(文字/图表内容编译依赖 P1-18/组合通道)。P1-14 pointer_move 宿主接线已完成并回填清单。
4. **P0 主线剩余**:P0-03/04/06 需要 Dashboard 发布链路(已核实 API 现无此通道)——**产品级架构切片,动手前需用户拍板**;P0-07/08 依赖 P0-01 后续与 P0-06。
5. **两份新计划**:doc1 PLAN-03 骨架已完成,下一步是 PLAN-04 统一实施(等批准)与 PLAN-01/02(样本下载/依赖锁定,注意网络与许可);doc2 材质第一批(顶点色是跨语言 ABI 扩展,公共合同大改,**需用户批准**)、基准 runner、S0 证据收敛。PLAN-03 的组合层约束(recipe×bundle 一致性、质量档字段)留给 PLAN-06/接线阶段。
6. **主线 D11–D23/D24–D28** 与 V 项按原任务表;浏览器下载落盘(三维)仍未证实。

## Open decisions(留给用户)

1. ConversionTaskService 统一(PLAN-04):跨模块重构,方案已写,等批准。
2. 材质顶点色(PbrMaterial 合同扩展):公共合同大改,等批准;flatShading 建议走“非索引几何等价”路线而非 shader 扩展。
3. Dashboard 发布链路(P0-03/04/06 前置):需要新建 API 通道,范围与优先级请用户定。
4. EBUSY 隐患:生成 PNG 移出 `apps/web/public/docs-assets/generated/`(或 Vite watch 排除),涉及文档任务产物路径,等确认。
5. 本夜 11 切片是否按切片 commit(逐文件审查后分批),还是整批留给下一会话审查后提交。
6. P1-06 持久分配器:数据已证否当前立项收益(0.1–0.2% stage 成本);除非显存峰值成为实测瓶颈(上限 ~264MB 场景),不建议重开。

## Skills to use

- `design-taste-digitaltwin` — V-02 视觉门禁未达,任何 UI/3D 产出必须走 Kimi-95 十维闭环。
- `engineering-taste` — 编码切片:先读后写→方案先行→对抗式自查→同族排查→10 维打分。
- 子代理并发上限约 2;GPU 单车道;共享文件(runtime_package/、mod.rs、发布链)单写者。

## Artifacts(本夜新增/修改的核心文件)

- Rust:`src/runtime_package/{types,validate,payloads,diff,mod}.rs`、`src/player_content*.rs`、`src/chart/{epoch,chunked_rows,rows,semantic_validation,legend_render,tooltip_render,render_cartesian,render_frame,geometry_frame,geometry_series,line_point_index}.rs`、`src/platform_text/raster.rs`、`src/app/chart.rs`、`src/app/chart_sim.rs`、`src/chart/simulation.rs`
- TS:`packages/deep-engine/src/runtimePackage/{types,builder,validation,chart,chartPackage,index,prewarmPlan}.ts(.test)`、`packages/deep-engine/scripts/generateChartRuntimeGolden.mjs`、`packages/deep-engine/fixtures/chart-runtime*.json`、`apps/web/src/delivery/{compileDashboardContent,dashboardWidgetContent,dashboardShapeContent}.ts(.test)`
- 文档:`docs/specs/deep2d-{chart-package,row-stats-cache,dashboard-widget-content,epoch-and-text-fit,chunked-rows-and-axis-pick}-2026-09-16.md`、`docs/specs/industrial-format-plan04-queue-audit-2026-09-16.md`、`docs/specs/deep2d-remaining-tasks-2026-09-16.md`(7 行状态更新)、`docs/active-task-recovery-ledger.md`(夜班五节)、`CHANGELOG.md`
- 测试输出:`test-output/p002-*`、`p003-*`、`p004-native-full.log`

## 明确排除

延续 00:45 交接全部排除项:非 Windows 实现、任意 JS/DOM 入 N0、8 小时 soak、账号/存储拓扑改动、
OSI 称谓;长尾格式解码、UE 虚拟几何、重型光追仍排除。资源修改不污染已发布版本;固定 admin/admin。
