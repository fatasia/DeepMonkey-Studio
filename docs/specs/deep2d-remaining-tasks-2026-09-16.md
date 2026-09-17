# Deep2D 剩余任务总表

> 2026-09-16 Codex 接手复核：本表的基础模块交付不等于整项验收通过。P1-18/P1-20 已复现字素簇边界和退格重做缺陷；先按 [复核与执行计划](codex-takeover-audit-and-plan-2026-09-16.md) 修复正确性与失败门禁，再继续下列任务。原完成条件全部保留。

更新时间：2026-09-16 00:45，北京时间（交接入口更新，45项状态未变）。供接手模型继续完成 [Deep2D 终局方案](Deep2D-跨时代发布终局方案-2026-09-15.md)。本表覆盖该方案 §2–§10 的全部未关闭任务及最终验收；两窗口已合为 [Deep Engine + Deep2D统一交接](C:/Users/rain/AppData/Local/Temp/Deep-Engine-Deep2D-handoff-2026-09-16-0045.md)，三维详细任务仍见其永久任务表。

恢复时先读 [总账](../active-task-recovery-ledger.md) 和仓库 `AGENTS.md`，再核对当前代码。本表替代旧 GLM 交接中的进度与执行顺序。历史规格中的“未开始”可能已过时，以下“已有部分”专门防止重复开发。

## 已完成

| 范围 | 当前证据与实现边界 |
| --- | --- |
| Deep2D 基础绘制 | 路径填充/描边/曲线/dash/clip、atlas v1/v2、letterbox、命中裁剪已有代码与 CPU/GPU 测试。参见 `packages/deep-engine-native/src/deep2d/`；旧支持矩阵“命中不支持 clip”已过时。 |
| ChartIR 与交互 | 六类系列、严格 v1 合同、legend/分页/隐藏、zoom、item/axis tooltip 聚合、选中及系列强调、折线原始点索引已有；实际系统输入与完整语义矩阵仍待。参见 [ChartIR](deep2d-chart-ir-v1-freeze-2026-09-15.md)。 |
| 数据更新与 sim | TS/Rust 数据消息、批量替换/滚动窗口、版本拒绝、行身份迁移、离线固定时间步 sim 与完整源回放已实现。参见 [数据](deep2d-chart-data-update-2026-09-15.md)、[sim](deep2d-chart-sim-2026-09-15.md)。 |
| 增量性能 | [系列路径/索引复用](deep2d-chart-series-incremental-2026-09-15.md)、[路径 GPU 局部传输](deep2d-vertex-transfer-2026-09-15.md)、[命令细分缓存](deep2d-path-cache-2026-09-15.md)、[共享数据快照](deep2d-chart-rows-snapshot-2026-09-16.md)已实现并验证。 |
| 二维包与作者形状 | [独立二维包](deep2d-dashboard-runtime-entry-2026-09-15.md)有真实 TS→Native golden；[作者内容](deep2d-dashboard-content-2026-09-15.md)只编译限定形状，`publicationReady=false`。 |
| 二维资源配置 | 空三维二维内容的 shadow 名义纹理从64MiB降至64KiB，跳过12 mesh+9 shadow pipeline；真实2D/3D切换与失败回退通过。不是总显存指标。 |
| 动态 ChartIR 入包(P0-02) | [v4 chart 包合同](deep2d-chart-package-2026-09-16.md)双侧实现:`chart-runtime`/`chart-sim-runtime` 载荷+信封身份、`buildChartRuntimePackage`、`from_package` 重建 ChartRuntime/sim 宿主、TS→Native golden 双夹具、真实窗口 sim 三帧提交与交互序列、恢复检查点。camera 自 v4 起可选;chart 与 deep2d 入口互斥。 |
| 字体基础 | `platform_text/raster.rs` 已用 cosmic-text 0.19 实际栅格化系统中文字体。`text_edit.rs`、`ime.rs`、`ime_winit.rs`、`glyph_atlas.rs` 有编辑/组合/atlas helper；这些不等于产品已接完整 IME/GlyphRun。 |

## 本轮待办：P0 接通实际发布

| ID | 剩余任务、已有部分与完成条件 |
| --- | --- |
| P0-01 | **完整 Dashboard 内容 lowering**——第一批已完成(2026-09-16,[spec](deep2d-dashboard-widget-content-2026-09-16.md)):全组件容器背景(与 Web 运行时逐值一致)、形状几何与内描边、逐对象 reasons/deferredFields/contentCompiled 登记、报告 chrome/content 计数。**剩余**:文字/图片/KPI/表格/图表/筛选内容编译、阴影、页面外观、publicationReady 放行条件。 |
| P0-02 | ~~**动态 ChartIR 入包**~~ **已完成(2026-09-16,见上方已完成表与 [spec](deep2d-chart-package-2026-09-16.md))**。剩余跟进:正式发布通道接线归 P0-06,能力报告归 P0-04。 |
| P0-03 | **DashboardDocument/绑定到权威发布版本**：静态 builder 已存在；补作者组件、数据绑定、字体/图片资源闭包、对象稳定身份与三端 loading。编辑、保存、刷新、发布、下载、离线打开同一版本；资源修改不污染已发布版本。 |
| P0-04 | **权威对象能力报告与三种 hash**：形状 pass 已计算 source/compile/target hash。接入实际发布 manifest、目标产物和平台证据，逐对象 supported/degraded/blocked/webview-only；任何 supported 都必须有对应 fixture、设备和字体范围。不要硬改 publicationReady。 |
| P0-05 | **Web/Three/Native 提交顺序一致**：先复用 `runtimePackage/prewarm*` 与已有 Native candidate/LKG，再核对三端 validate→dependency closure→prewarm→frame→present→LKG 的实际执行。补取消、迟到结果、连续换包和坏资源回退，不新建第二套 loader。 |
| P0-06 | **正式 Dashboard 动态交付证据**：三维 D06/D10 主线已有冻结依赖、候选服务、正常窗口、ZIP launcher 等实现；直接接这些能力。需证明 Dashboard 动态包也能走真实发布与离线启动，不能借用 BoxTextured 的报告当二维证据。主线最终状态以其交接和总账为准。 |
| P0-07 | **同源跨端结构与行为 golden**：已有 Chart/数据/sim/静态包黄金夹具；补完整 Dashboard 布局、内容、文本和交互的三端对照。比较实际 producer 输出、对象/资源身份、命中和完整状态轨迹；值归一化遵守合同。 |
| P0-08 | **WebGPU/Native 像素与输入矩阵**：已有 Native GPU readback；补 Browser 同 fixture、双主题、标准与窄窗、DPI、真实 OS 输入、阈值和差异原因。正常窗口/64×64 smoke/纹理读回/系统截图分别记录，不能互换。 |

P0 进入点：`apps/web/src/delivery/compileDashboardContent.ts`、`packages/deep-engine/src/runtimePackage/`、`packages/deep-engine-native/src/runtime_package/`、`player_content.rs`。修改共享发布/相机/启动文件前先对照三维主线交接。

## 本轮待办：P1 动态核心与性能

### 数据、Epoch 与渲染

| ID | 剩余任务、已有部分与完成条件 |
| --- | --- |
| P1-01 | ~~**全局 Epoch**~~ **已完成(2026-09-16,见[spec](deep2d-epoch-and-text-fit-2026-09-16.md))**:ChartEpoch 五元组+同源 data_revision+ChartEpochCommit 事务(publish 后纯赋值落地),update/change_legend_page 事务化,7 项测试含失败全保持证明。剩余:resize 接线 layout_revision、GPU 窗口端到端失败注入。 |
| P1-02 | **全局依赖图和增量失效**——第一批已完成(2026-09-16):painter_cache 失效原因记账(structure→clip→resource→style 固定顺序+evicted 有损记忆),行为逐字节等价;8 项子图失效证明测试(改 A 只 miss A,含原因顺序证明与 JSON 输出)。第二批子切片已完成:成功整帧按 display command id 清理缓存孤儿条目，`deletions` 计数可观测，失败候选不清理，删除/重加回归通过。**第二批已完成(2026-09-16,[spec](deep2d-path-cache-dependency-graph-2026-09-16.md))**:epoch/相机帧级维度进依赖图(`EntryWitness`+`set_resource_epoch`/`set_camera_scale`,归因序 相机→epoch→结构→clip→resource→风格),并**修掉见证与细分缩放不同源的真实缺陷**(会永久命中错误几何);数据 revision/z 序/hitId 刻意不进图并有测试锁定。**剩余两项已完成(2026-09-16 接手会话,[spec](deep2d-host-wiring-and-transfer-accounting-2026-09-16.md))**:①宿主侧接线——`Deep2dFrameContext`+`new_with_context`/`stage_update_with_context`,`deep2d_frame_context` 用 letterbox 实际比值(非标称 DPI),chart/换包/换页三条生产路径全部接线,5 项测试锁定「DPI 真的进了细分几何」;②vertex transfer 侧归因记账——`VertexTransferReasons` 六分类(content_reused/incremental_copies/no_previous_frame/previous_not_copyable/plan_rejected/below_copy_threshold),与 path cache 的 miss 账构成两层可观测,2 项测试锁定判定顺序与「每次 upload 恰记一条」。 |
| P1-03 | **混合值列式分块**——存储层已完成(2026-09-16,见[spec](deep2d-chunked-rows-and-axis-pick-2026-09-16.md)):`chunked_rows.rs` 行块 Arc 共享/整块窗口淘汰/部分边界仅复制首块/预算 fail-closed,5 项测试含引用计数证明;未接 ChartIR(任务明示)。**剩余**:接分块数据窗口到实际数据通道。 |
| P1-04 | ~~**缓存行统计与局部校验**~~ **已完成(2026-09-16,见[spec](deep2d-row-stats-cache-2026-09-16.md))**:统计随不可变行存储惰性缓存、DerefMut 自动失效、三处扫描改查询且语义等价;release 热路径 median 4.7761ms→0.279/0.3816ms。冷/热/失效/坏数据/边界对照 3 项测试通过。 |
| P1-05 | **减少几何/命中路径复制**——第一批已完成(2026-09-16,见[spec](deep2d-frame-chunks-and-gpu-transfer-2026-09-16.md)):帧内存按系列三 Arc chunk + OnceLock 惰性扁平视图,增量更新命令内存 8 份→1 份(-13% prepare),等价性以 ptr_eq/z 序逐值证明;诚实修正:克隆本就 O(1),真实收益在更新路径。**第二批评估完成,数据否决改造(2026-09-16 接手会话)**:新增呈现层克隆基准——`display_list().clone()` median **0.0149ms**(占 prepare 2.09ms 约 0.7%),真正的成本是扁平视图首次物化 0.366ms(每帧一次,拼接期统一定版 z 序/revision 是已锁定语义);消除它需改公共消费面契约,收益不足以支撑,记录在案。 |
| P1-06 | ~~**持久 GPU 分配与传输策略**~~ **评估完成,数据否决 ring/arena(2026-09-16,见[spec](deep2d-frame-chunks-and-gpu-transfer-2026-09-16.md))**:分配 0.1–0.2% stage 成本(噪声级);「发布即不可变」为刻意设计,经 cache 复用会缓存投毒,持久分配器需跨 deep2d_gpu 立项。落地 `buffer_allocations` 可观测字段+三场景字节预算断言+逐像素旧帧保护+release 计时基准。 |
| P1-07 | ~~**细分缓存冷启动与重复驻留**~~ **已完成(2026-09-16)**:计数分配器实测——payload 记账低估真实堆 ~6%(量级可信);**重复驻留证实**存在(缓存顶点与 8MiB shadow 全量重复,夹具 1.12MB),Arc 化需跨禁区文件,立项数据已备;冷启动拆解:可归因缓存写入 0.056ms(基线 0.5%),其余在噪声底 ±0.3–0.4ms;实施 clips 单次收集小优化。**剩余**:shadow 捕获成本/Arc 化(GPU 车道+跨文件立项)。 |
| P1-08 | **真实文字/atlas 增量**——第一批已完成(2026-09-16):`GlyphRasterCache`(双预算 4096 条/8MB LRU,值 Arc 引用计数,错误不入缓存下次重试,resource_revision 插入/逐出前进)+ `GlyphAtlasBook.place_text` 接真实栅格产物;同 key 免重栅格(计数断言)、size 变化全重建、clear/逐出不污染在用值。7 项测试。**第二批评估(2026-09-16 接手会话)**:区域上传需上游「脏矩形」通道,当前 `PreparedDeep2dAtlas` 只有整块 data;实测 chart 场景 atlas 总量约 **63KB**(6 张,键盘 smoke 与静态包一致),整块重传在 PCIe 上是微秒级,收益不可测量。**数据否决引入跨层脏矩形通道**;per-cluster 字形级与色分离优化同此判断,待 atlas 规模进入 MB 级再重估。 |
| P1-09 | **纯二维残余分配**——**测量与判据已完成(2026-09-16 接手会话)**:①IBL 约 27KB、紧凑阴影 64KB,量级可忽略;②**前向目标约 44 字节/像素**(HDR 8 + 4xMSAA 32 + Depth24 4),1280×720 约 40MB,是唯一大头;已确认 `output_pass.draw` 用 `LoadOp::Clear` 且 Deep2d 直接画 surface(零像素依赖),纯 2D 帧里它确实是白造的。落地 `content_profile::planeless`/`skip_forward_targets` 判据(探针与实例两道否决)并进入 `ContentProfileReport` 启动报告,5 项测试锁定含字节口径断言。**剩余**:真正跳过帧路径需重排 output_pass 绑定,属独立切片(需真实窗口像素对比与双主题闭环)。 |
| P1-10 | ~~**端到端 CPU/GPU 性能基线**~~ **已完成(2026-09-16)**:`tests/chart_e2e_perf.rs` 真实 Win32+Vulkan 窗口 1280×720、8×8192 夹具,七场景(初始/静态/局部/全量/resize/图例/tooltip)各 30 采样 P50/P95/P99;CPU prepare+GPU timestamp(可用,含降级分支)+present 延迟+上传字节+显存估计,机器可读 JSON 单行输出。关键基线:静态帧 0.21ms、局部 8.7ms、全量 27.1ms、上传零重传(内容寻址健康)。声明单机单卡,无跨设备/FPS 结论;降级分支未实测(本机支持)已注明。 |
| P1-11 | ~~**缓存故障与裁剪矩阵**~~ **已完成(2026-09-16)**:R1 缓存失效 11 格(atlas 内容/revision 不参与 key/几何内容驱动失效/style 各维度/超预算逐出与 thrash 等价/重载零漂移/坏候选不污染)+R2 深层 clip(3 层嵌套×旋转/镜像/nonuniform×dash+stroke,资源各自变更只牵连依赖命令)+R3 GPU 混合内容(文字+图片+clip 路径同帧,CPU raster_reference 400/400 像素精确一致;同 id 换像素新建 texture;候选拒绝旧帧保持;新 epoch 零复用)。src 零缺陷零修改。**未覆盖(注明)**:真实 device-lost 回调不可注入,以新 epoch 重建替代。 |

性能接手入口：`chart/rows.rs`、`runtime_data.rs`、`chart_ir.rs`、`semantic_validation.rs`、`geometry_frame.rs`、`deep2d/painter_cache.rs`、`deep2d_vertex_transfer.rs`、`deep2d_gpu.rs`。所有路径都先测量再决定改造。

### 数据连接与图表交互

| ID | 剩余任务、已有部分与完成条件 |
| --- | --- |
| P1-12 | ~~**sim 普通窗口与失败恢复**~~ **已完成(2026-09-16)**:`pump()` 唯一推进实现(渲染 gate 在 prepare 前,失败不碰游标)+`wake_delay()` 纯调度数学;`--smoke-chart-sim` 升级为 8 阶段注入(正常视口/空闲/到期/积压追赶/失败注入/恢复续跑/取消),5 项固定时钟生命周期测试+真实 GPU 冒烟。**剩余**:真实换包端到端 GPU 注入(包切换通路归 P0 主线)。 |
| P1-13 | **宿主数据源状态机**——第一批已完成(2026-09-16):`chart/data_source.rs` 离线优先状态机(Disconnected/Connecting/Connected/Retrying/Closed,注入时钟+Transport trait 零真实 IO),版本治理(迟到/重复/串源拒绝)、有界环形离线缓存+水位续传对接、凭据类型上不出现;CAS 经 payload→ChartDataMessage 适配对接真 ChartRuntime。11 项测试。**第二批已完成(2026-09-16 接手会话)**:①**缓存字节预算**——`cache_byte_budget` 与条数上限共同生效(谁先触顶谁淘汰),单条超预算不入缓存但照常交付(`cache_oversized` 计数),`cache_bytes()` 可观测;②**宿主静默窗口**——`idle_deadline_ms` + `last_activity` + `poll_idle_deadline`,覆盖同步 Transport 下「连接建立后无活动」这一唯一可观察的死链形态(握手驻留要等真实异步绑定),收发事件刷新窗口、`on_receive_at` 带时间戳重载保持既有调用方零改动。6 项新测试(共 17 项)。**修订说明**:任务原写「宿主侧 deadline」,实测同步 Transport 下 `connect()` 立即返回、不存在可观察的在途窗口,故口径改为静默窗口并如实记录。**剩余**:HTTP Transport 真实绑定(受控 HTTP/订阅/异步握手/TLS)。 |
| P1-14 | ~~**Axis 最近X与线段拾取**~~ **已完成(2026-09-16,见[spec](deep2d-chunked-rows-and-axis-pick-2026-09-16.md))**:XInverter 三态反解×zoom、nearest_x 跨dataset聚合(前景优先/row身份不变)、线段补空隙顶点绝对优先(系列级命中合同一致)，并已接入 `pointer_move` 的 axis tooltip 宿主组装(16px 逻辑容差，bar-only 命中回退)。新增 pointer regression 后相关测试通过；RTX 4060 Laptop/Vulkan 真实窗口 smoke 的 initial/zoom/reset/tooltip/clear 序列提交成功。 |
| P1-15 | ~~**单行持久强调与交互细节**~~ **已完成(2026-09-16)**:`MarkerKind{Selected>Emphasis>Hover}` 强度合成(accent 持久/hover 瞬态),隐藏保留状态恢复渲染,AppendWindow 淘汰+行身份迁移(旧3→新0合同),row 覆盖系列/单行 downplay/系列全清;authored `Highlight/Downplay{data_index}` 既有通道,无新 action。11 项新测试(chart_emphasis_markers 5+chart_emphasis 3 新增+既有),state_render 断言最小收窄(新语义使旧断言过强,已披露)。**剩余已完成(2026-09-16 接手会话)**:`ChartAction` 新增运行期 `Highlight{series_id,data_index}`/`Downplay{...}`,对齐 TS/ECharts 的 `dispatchAction({type:"highlight"/"downplay"})`;`initial_state` 的初始 highlight/downplay 改为经同一条 `apply` 路径派发(此前直接写 emphasis 并 `continue`,形成「初始能表达、运行期无入口」的双轨);未知系列/隐藏系列守卫与既有动作一致。2 项新测试锁定「初始与运行期落到同一强调状态」与守卫语义。 |
| P1-16 | **图表键盘与辅助功能**——第二批已完成(2026-09-16):**焦点环已画进图例像素**(append_legend 按 `focused_item` 在焦点项外扩 3px 画 accent 描边环,z 同层后入盖顶,页级稳定 id;越界焦点静默跳过),焦点移动/释放触发图例重呈现使环跟随;第一批键盘状态机与双图对拍保持。**第三批已完成(2026-09-16 接手会话)**:新增 `--smoke-chart-keyboard` 真实窗口键盘 smoke(`app/chart_keyboard_smoke.rs`),复用生产入口 `window_events::chart_key`(非复制判定)按序驱动 Tab 聚焦→方向键移动→Space 激活→Esc 释放→重新聚焦 6 阶段,每步断言可观察状态变化与展示列表形状变化;**RTX 4060 Laptop/Vulkan 真机 6 阶段全绿**(命令数 17→18→18→18→17→16→17,焦点环真的进像素)。过程中修复两处探针口径错误(焦点环不推进几何帧 revision,须比较展示列表形状;图例激活语义是切换隐藏而非 selected)。**剩余**:OS 屏幕阅读器桥(焦点环与语义树已就绪,桥接仍是独立切片)。 |
| P1-17 | ~~**真实文字测量/省略和布局**~~ **已完成(2026-09-16,见[spec](deep2d-epoch-and-text-fit-2026-09-16.md))**:rasterizer measure()、fit_ellipsis 二分测量截断(图例含图标占宽)、tooltip 按行整体实测;3 项新测试+既有回归通过。剩余:单位/术语系统一致性巡查随 P1-19 字体包推进。 |

### 文本与行为

2026-09-16 Codex 复核修正：下表保留原交接记录，当前实现与验证见 [A/B 执行记录](codex-native-correctness-and-gates-2026-09-16.md)。P1-18 已改为完整 Unicode 字素重映射；P1-20 使用完整不可变文档快照恢复历史，取代区间夹取；P1-21 四种终态共享有界 FIFO 身份窗口，窗口外宿主仍不得复用 ID。表中原测试数为交接时数字，剩余跨端与宿主验收继续有效。

| ID | 剩余任务、已有部分与完成条件 |
| --- | --- |
| P1-18 | **TextDocument/GlyphRun 合同**：已有真实中文 raster 与基础编辑helper；定义稳定文本/样式区间/段落/inline object、字素簇/bidi/fallback/断行/selection到版本化 IR，TS/Rust共同解释并可局部失效。**Rust 侧已交付(2026-09-16 接手会话,[spec](deep2d-text-document-ir-2026-09-16.md))**:`platform_text/text_document.rs` 的 `TextDocumentV1`——区间一律**簇索引**而非字节偏移(多字节/组合序列不被切开)、样式用标识而非内联属性、半开区间二分查询、修改返回 `TextChange` 供局部失效、被拒修改不推进 revision、段落与 inline object 双轨(对象锚定簇位置)。复用既有 `grapheme_clusters`,不造第二套文本模型。16 项测试;对抗式自查**抓到并修复三个真实缺陷**(删除跨多区间产出重叠区间、段落「每簇必属某段」只在编辑期维护导致构造期留空洞、inline object 压缩后重复位置),修复后构造期与编辑期共用同一补全实现。**剩余**:TS 侧同一合同与跨语言 golden(bidi/fallback/shaping 仍依赖已批准的 shaping 库,不冒充完整实现)。 |
| P1-19 | **字体包与能力矩阵**——**身份冻结与能力矩阵已交付(2026-09-16 接手会话,[spec](deep2d-font-capability-2026-09-16.md))**:`platform_text/font_capability.rs` 以**字体数据 FNV-1a hash** 作唯一可信身份(家族名相同不代表文件相同),矩阵按 hash 稳定排序去重、跨机器可复算;来源/许可显式建模,系统字体一律 `usable_in_artifact=false`(能渲染≠可交付,保守默认有测试锁定);`family_blocked_reason` 区分「机器没装」与「装了不能发」;产品路径经 `TextRasterizer::font_capability()` 在启动报告输出一次(实测全库遍历约 9ms,仅图表内容存在时执行)。**顺带修正一个语义陷阱并固化**:整形器遇缺失家族会静默 fallback,故成形结果**不能**证明家族覆盖,已拆成 `family_exists`(家族可用性的正确判据)与 `text_shapes_without_missing_glyphs`(系统整体成形能力)两个口径。8 项测试。**剩余**:字体内嵌与子集化(需先解决再分发权,属独立决策)、跨机器实测比对、逐 codepoint cmap 覆盖矩阵、按能力报告阻断发布的消费方。 |
| P1-20 | **真实IME事务**——**事务会话已交付(2026-09-16 接手会话,[spec](deep2d-ime-and-behavior-ir-2026-09-16.md))**:`platform_text/ime_session.rs` 的 `ImeSession` 把既有三 helper 收成事务化会话并接 P1-18 的 `TextDocumentV1`。五条不变量各有测试:①组合期文档逐字节不变(preedit 与取消都不触碰文档/revision);②提交经单一编辑路径产出 `TextChange`;③失焦必取消在途组合(不得遗留);④撤销按事务粒度且自身推进 revision,redo 被打断;⑤删除按簇(emoji 4 字节 1 簇、组合序列整体删)。**对抗式测试抓到真实缺陷**:初版历史条目只记一个簇区间,撤销与重做口径不同(插入型要在空位置重插、删除型要重删区间),导致 redo 越界失败;已改为同时记 `insert_at`+`inserted_clusters`+`is_insert` 并夹取当前文档边界。16 项测试。**剩余(诚实)**:bidi/RTL 重排未实现(需已批准 shaping 库);DPI 候选窗未实现(由宿主窗口层绘制,本模块只提供 caret 锚点,不声称 OS 级验收);未接产品窗口事件循环。 |
| P1-21 | **Behavior IR 与命令总线**——**已交付(2026-09-16 接手会话,[spec](deep2d-ime-and-behavior-ir-2026-09-16.md))**:`behavior_ir.rs` 的 `BehaviorCommand`(封闭枚举)+ `CommandBus<T: BehaviorTarget>` + `HostCapabilities` + `CommandBudget` + `CommandCounters`。与 `ChartAction` 划清边界:后者是图表专用语义,本模块是**通用容器**(身份/幂等/CAS/取消/能力门控/预算/可观测),语义经 `BehaviorTarget` 注入(同 `data_source::Transport` 范式)。**N0 铁律落实**:载荷是封闭枚举而非任意 JSON,标量类型刻意不含字符串(防「用数据当代码」),能力缺失即拒绝不做降级。**两阶段提交**(submit 校验预留 → settle/cancel):幂等在 submit 消耗、CAS 在 submit 与 settle 双次核对、取消后 settle 返回 `Cancelled`(区别于从未提交的 `NotInFlight`)、预算硬拒且取消释放额度、幂等键与取消记忆有界且有损(计数可见);时间全部注入 `now_ms`,零真实 IO。自查修正一处语义混淆(应用失败曾复用 NotInFlight,已独立为 `ApplyFailed`)。20 项测试(六组合同 + 对抗式)。**剩余**:真实异步运行时、签名扩展(P3-03)、宿主档位接线。 |
| P1-22 | **统一固定步回放**：扩展现有sim固定时钟到行为/动画/随机种子/输入事件，比较命令序列、状态轨迹和display hash。网络副作用只用显式replay fixture，过期命令拒绝且不改变旧epoch。 |
| P1-23 | **N1版本化适配器**：认证高价值SVG/富文本inline/图表扩展/特定动画ABI：输入schema、批量display delta与命令，资源和预算归宿主管理。没有fixture的平台组合保持unknown/blocked。 |

## 本轮待办：P2 有淘汰条件的兼容实验

| ID | 剩余任务与完成条件 |
| --- | --- |
| P2-01 | **兼容开关和隔离边界**——**无脚本首切片已完成(2026-09-17，[spec](deep2d-p2-01-x-compat-isolation-2026-09-17.md))**：`compat_x` 明确 N0/X lane 与关闭开关；封闭调用树只读宿主注入的资源/时钟/种子化随机/事件，无 DOM/GPU/文件/网络对象；CPU work units、内存、调用深度、消息条数/字节、wall-clock 均硬拒绝；evaluate→publish 两阶段重查取消/迟到/旧 epoch。**剩余**：独立受限进程、进程崩溃/终止隔离与正式 IPC；本切片不运行真实 JS、不宣称 ZRender/ECharts 兼容。 |
| P2-02 | **ZRender Painter 批量命令实验——受限动态 bar 切片已完成(2026-09-17，[spec](deep2d-p2-02-zrender-painter-batch-experiment-2026-09-17.md))**：真实 ECharts/ZRender 6.1.0 无 DOM SVG SSR，同一实例输出 stable-id rect upsert/remove；输入与完整输出快照 SHA-256 已冻结并 10/10 双跑一致；预算/错误保持上一 epoch/hash。formatter、图片、tooltip、动画、非 rect displayable 继续明确 blocked，未认证完整 Painter/ECharts 生态；独立受限进程仍归 P2-01 剩余。 |
| P2-03 | **中文富文本输入实验**——**首个离线轨迹切片已完成（2026-09-17，[spec](deep2d-p2-03-rich-text-ime-trace-2026-09-17.md)）**：同一 fixture 覆盖中文、combining、ZWJ emoji 的 composition/commit、簇光标、离线 advance、取消与越界拒绝；N0 是事务真源，N1 仅消费成功 commit 后快照。**剩余**：formatter、动画、异常/超时宿主轨迹，X lane 对照，真实 Windows IME 与 cosmic-text/bidi/fallback/换行像素证据。 |
| P2-04 | **认证与淘汰报告**：记录脚本/图表版本、输入/输出hash、预算、timeout和上一epoch保持。若依赖DOM仿真、每帧整图重建或批量输出不稳定，停止扩展回N0/N1；HTML rich text/ECharts-GL/扩展分别认证，未覆盖保持阻断。 |

P2实验仍属目标，但不得把任意JS、完整ECharts或DOM兼容偷放入N0。若产品最终关闭X，明确记录关闭及能力报告阻断；不要以“实验待定”删除这部分验收。

## 本轮待办：P3 热同步与扩展

| ID | 剩余任务与完成条件 |
| --- | --- |
| P3-01 | **对象级内容寻址delta**：复用现有包diff/watch/LKG，接document/data/layout/resource增量、资源依赖闭包、下载/校验/预热/present后提交；迟到delta、丢包、schema不兼容保留旧版并给诊断。 |
| P3-02 | **编辑期三端预览**：同一作者revision驱动Web/Three/Native，展示实际降级/阻断对象，取消陈旧编译、相同对象选择联动、失败不污染当前预览。 |
| P3-03 | **签名扩展与HostCapabilities**：版本/签名/权限/资源预算/ABI协商与兼容报告，扩展单独分发，支持撤销/失败回退；不混入纯Native runtime载荷。 |
| P3-04 | **Windows设备/驱动能力矩阵**：覆盖已声明Windows目标和WebGPU/Native后端、字体/DPI/显存限制、设备丢失和恢复。新增后端的lowering/宿主/验证三部分合同要明确；不因此重启非Windows实现。 |
| P3-05 | **实际发布升级与回滚**：从正式包和真实客户端验证连续更新、离线旧版、坏hash/schema、资源缺失、取消和恢复检查点；复用主线可信证据和版本历史。 |

## 项目级后验收

| ID | 必须完成的交付门禁 |
| --- | --- |
| V-01 | 完整用户流：编辑→保存→刷新恢复→发布→公开/授权读取→下载→离线启动→更新→回滚。覆盖权限过期/401、断网/5xx、重复提交、并发保存、空/错误态。 |
| V-02 | `design-taste-digitaltwin` Kimi-95流程：Design Read、令牌、至少两轮真实截图修复、10维评分、同族排查、对标引用。双主题、标准/980px窄窗、DPI、所有控件真实操作；当前未达到此门禁。 |
| V-03 | 三证与资源证完整：来源/IR/target hash、结构/状态轨迹、Browser与Native视觉阈值、字体/设备范围、内容闭包与预算；支持报告只引用匹配的证据，未知组合不放行。 |
| V-04 | 短时稳定性、内存/资源峰值、设备丢失、失败注入、取消和回滚，端到端性能无回退；8小时soak已取消。 |
| V-05 | 相关类型检查/单测/构建、Web公共修改时全量与浏览器门禁、`pnpm gate:repository`、文件/函数体量和许可证检查；审查并只提交已验证的本片文件，不整批提交脏工作树。 |

## 明确排除

- 非Windows平台实现、完整Three插件逐个兼容、复杂Shader Graph产品、重型光追/路径追踪、UE完整虚拟几何、长尾格式新解码器。
- 把任意JS/任意ECharts/任意HTML CSS标为N0原生支持；这些只按上述限定实验与W/X能力处理。
- 恢复8小时WebGPU长稳要求；改动现有账号、数据库/对象存储拓扑或既有用户数据。

## 建议接手顺序与第一小时

1. 核对总账、git log/status和三维主线交接，确认无构建/GPU占用；读四个性能spec，避免重复做已完成缓存。
2. 跑 `cargo test --manifest-path packages/deep-engine-native/Cargo.toml --test 'chart_*' --lib`、`cargo check --manifest-path packages/deep-engine-native/Cargo.toml --all-targets`、`pnpm gate:repository` 建立当前基线。
3. 默认先做 P0-02 动态ChartIR入包与普通窗口，接已有sim和发布容器；这是从独立demo到真实交付的缺口。若继续性能，先选 P1-04 行统计缓存，保持所有校验语义并做冷/热/局部/坏数据对照。
4. 完成单片后回填本表/总账/CHANGELOG，推进P0其他行；再按Epoch、文本/行为、兼容实验与P3顺序。未验证的功能留在本表，不用进度百分比替代状态。

## 当前可复用性能证据

以下数据均为单机固定夹具，不得相加推算整帧或跨设备收益；参数和复现命令见各链接spec。

| 阶段 | 同轮结果 |
| --- | --- |
| 源快照，8×8192混合值行 | 逐单元复制median25.5731ms，共享0.0124ms；未含校验/更新/几何。 |
| 重复完整源校验，同一夹具 | median4.7761ms/P95 7.2712ms；缓存尚未实现，这是后续优化基线。 |
| 几何，8系列×8192行，改1系列 | 旧全帧11.3270ms，当前全量10.5913ms，局部3.8502ms。 |
| 细分，128曲线路径，改1条 | 无缓存13.0562ms，冷缓存13.7404ms，局部0.8106ms；冷构建约增加5%。 |
| GPU路径传输，128散点，改1点 | 路径总55296字节，CPU上传432、GPU复制54864；同次127细分命中/1miss，1绘制批次，像素一致。仍创建完整候选buffer。 |

## 收尾验证状态

ChartRows新增5项，数据7/消息5/sim9/系列增量5通过；chart集成全套和lib全套通过，Native bin81通过/28显式GPU忽略，all-target通过。细分/局部传输上一片真实GPU chart12+deep2d6通过；修改行容器后没有重跑GPU。Release源快照与重复校验基准均执行成功。仓库门禁曾遇并行README图片断链，资产恢复后本窗口最终repository gate、范围diff检查、all-target检查均通过，无warning。交接结构和敏感信息检查均通过，本窗口没有运行中的测试/GPU任务。
