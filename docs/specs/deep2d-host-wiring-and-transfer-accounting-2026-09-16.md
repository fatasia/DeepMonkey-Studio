# Deep2D 接手会话:宿主接线、传输记账与四项剩余切片(2026-09-16)

承接 [GLM 夜班交接](../GLM-Deep-Engine-Deep2D-交接-2026-09-16.md) 与
[Deep2D 剩余任务总表](deep2d-remaining-tasks-2026-09-16.md)。本会话从 GLM 交付态
(Native 826/0/59)接手,完成 P1-02 两项剩余、P1-13 第二批、P1-15 剩余、P1-16 第三批,
并对 P1-05/P1-08/P1-09 做测量与决策。

## P1-02 剩余①:宿主侧接线(本轮最重要的行为修正)

**缺口**:GLM 引入的 `EntryWitness`(epoch/相机)已具备语义与测试,但宿主从未调用
`set_resource_epoch`/`set_camera_scale`,`deep2d_gpu.rs::stage` 也没传上下文——运行时
行为与第一批等价,依赖图里的两个维度实际是死的。

**落地**:

- `Deep2dFrameContext { resource_epoch, camera_scale }` + `deep2d_frame_context()`
  (纯函数,app 与 renderer 共用):缩放口径取 **letterbox 实际比值**
  (`physical/logical` 取宽高比最小值),不是窗口 DPI 标称值——二者只在逻辑尺寸等于
  物理尺寸时相同,非等比窗口会缩小实际缩放。
- 入口:`Deep2dGpuPainter::new_with_context` / `stage_update_with_context`,
  renderer 侧 `stage_deep2d_update_inner`;三条生产路径全部接线:
  - `app/chart.rs::update` → 当前 `resource_set`;
  - `app/chart.rs::change_legend_page` → **目标页号**(提交换页前的目标态,
    传旧值会让旧页条目漏掉这次失效);
  - `app/package_live.rs::apply_deep2d` / `renderer/drop_preview.rs` → 候选内容的
    epoch(`document_revision` 折 `resource_set`),同包重复发布幂等、不同包整批失效。
- 未提供上下文时两个维度保持 `None`,行为与第一批逐字节一致(既有测试零改动)。

**关键约束(接线中确立)**:整帧只能有**一个**物理缩放。`display_list.scale_factor`
同时被 path 细分、文字/图片 quad、clip 集、stroke 容差消费;若只把显式值喂给缓存见证,
就会重现 GLM 修掉的「见证与几何不同源」缺陷。因此 `painter.rs` 增加
`effective_scale()`,在进入命令循环前定格一次,四处消费点统一取值。

**验证**:`src/deep2d_context_wiring_tests.rs` 5 项,其中
`host_declared_scale_changes_tessellation_and_matches_static_equivalent` 断言
1x 与 2x 顶点数**不同**(证明 DPI 真的进了细分,而非只调用了一次 API),
`real_dpi_reaches_the_dependency_graph` 用 480x320 内容 + 960x640 物理像素锁 2.0。

## P1-02 剩余②:vertex transfer 侧记账

`VertexTransferReasons` 六分类:`content_reused` / `incremental_copies` /
`no_previous_frame` / `previous_not_copyable` / `plan_rejected` / `below_copy_threshold`。

- 判定顺序固定并抽出纯函数 `upload_reason(has_previous, copyable, planned)`,
  便于锁定顺序而不依赖真实 GPU;`total()` 恒等于 stage 次数(每次 upload 恰记一条)。
- 与 path cache 的 miss 账构成**两层可观测**:缓存账答「细分为什么重算」,
  传输账答「顶点为什么重传」,交叉才能区分「几何没变但传输退化」与「几何确实变了」。
- 启动报告新增两行:`path cache misses:`(六维分解)与
  `vertex transfer reasons:`(六类 + stages)。

**验证**:2 项新测试(`deep2d_vertex_transfer_tests.rs`),覆盖判定顺序与累计口径。

## P1-13 第二批:缓存字节预算 + 宿主静默窗口

- **字节预算**:`cache_byte_budget` 与 `cache_capacity` 共同生效,谁先触顶谁淘汰;
  单条超预算不入缓存但仍交付(`cache_oversized` 计数)——避免一条撑爆缓存或连环淘汰。
  `cache_bytes()` 可观测。
- **宿主静默窗口**(原任务写「宿主侧 deadline」,口径修订):
  同步 `Transport` 合同下 `connect()` 立即返回,不存在可观察的在途窗口,**实测确认**
  后改为覆盖「连接建立后无活动」这一唯一可观察的死链形态。
  `idle_deadline_ms` + `last_activity` + `poll_idle_deadline`;收发事件刷新窗口,
  新增 `on_receive_at(payload, now_ms)` 带时间戳重载保持既有 11 项调用方零改动。
  取消/退避清理窗口;未设(0)时彻底空操作。

**验证**:6 项新测试(data_source 共 17 项),含字节守卫、超预算不入缓存、
窗口刷新与顺延、终态幂等、未设空操作、配置边界。

## P1-15 剩余:运行期 emphasis 与 ChartAction 合同对齐

**缺口**:TS/ECharts 的 `dispatchAction({type:"highlight"/"downplay"})` 在 Rust 侧
无对应入口——初始动作里 highlight/downplay **直接写 emphasis 状态并 `continue`**,
绕过 `ChartAction` 派发通道,形成「初始能表达、运行期无入口」的双轨。

**落地**:`ChartAction` 新增 `Highlight{series_id, data_index}` / `Downplay{...}`;
`initial_state` 的初始动作改为经同一条 `apply` 路径派发;守卫与既有动作一致
(未知系列 `UnknownSeries`、隐藏系列 `HiddenSeriesAction`)。

**验证**:2 项新测试锁定「初始与运行期落到同一强调状态」(含 downplay 对称)
与守卫语义。测试第一版曾因共享夹具自带初始 highlight 而失败——那是指纹口径问题,
改为先清空 `actions`/`data_zoom` 建立干净基线。

## P1-16 第三批:真实窗口键盘 smoke

新增 `--smoke-chart-keyboard <chart-ir.json>`(`app/chart_keyboard_smoke.rs`),
**复用生产入口** `window_events::chart_key`(提升为 `pub(super)`,不是复制判定),
按序驱动 6 阶段:Tab 聚焦 → ArrowRight → ArrowLeft → Space 激活 → Esc 释放 → Tab 重新聚焦。

每步断言**可观察状态变化**:焦点翻转/移动、激活后隐藏集合变化、以及焦点真的变化时
展示列表**命令形状**必须改变(含变换位模式,因为焦点环 id 按页命名、同页移动只改几何)。

**真机结果(RTX 4060 Laptop / Vulkan)**:6 阶段全绿,命令数 17→18→18→18→17→16→17,
每步 `scopes=clean callbacks=clean`。补上了此前「真实窗口键盘 smoke 未跑」的诚实缺口。

**过程中修正两处探针口径错误**(非产品缺陷):①焦点环不推进几何帧 revision
(图例层用自己的 revision),须比较展示列表形状;②图例项激活语义是**切换系列可见性**,
不是选中数据点。

## P1-05 第二批:测量后数据否决

新增呈现层克隆基准(`tests/chart_frame_chunks.rs`):

| 项 | median |
| --- | --- |
| 呈现层 `display_list().clone()` | **0.0149 ms** |
| 扁平视图首次物化 | **0.366 ms** |
| 扁平视图重复读 | 0.0001 ms |
| 局部数据更新(重建 1 系列) | 0.757 ms |

克隆占 prepare(2.09ms)约 **0.7%**,不是瓶颈;真正的成本是首次物化 0.366ms,
而它承载「拼接期统一定版 z 序与资源 revision」这一已由测试锁定的语义。
消除它需改公共消费面契约,收益不足。**数据否决,不改造。**

## P1-08 第二批:测量后数据否决

区域上传需要上游「脏矩形」通道,而 `PreparedDeep2dAtlas` 只有整块 `data`。
实测 chart 场景 atlas 总量约 **63KB**(6 张;键盘 smoke 与静态包输出一致)——
整块重传在 PCIe 上是微秒级,收益不可测量。**数据否决引入跨层脏矩形通道**;
per-cluster 字形级与色分离同此判断,待 atlas 规模进入 MB 级再重估。

## P1-09:测量与判据(未改帧路径)

| 资源 | 占用 | 是否与像素相关 |
| --- | --- | --- |
| IBL(内建 studio-ibl) | 约 27 KB | 否 |
| CSM 紧凑档 | 64 KB | 否 |
| 前向目标(HDR+4xMSAA+Depth) | **约 44 B/px**;1280x720 ≈ **40 MB** | `output_pass` 以 `LoadOp::Clear` 覆盖,Deep2d 直接画 surface |

结论:IBL 与紧凑阴影合计约 91KB 可忽略;**前向目标是唯一大头**,已确认它与 Deep2d
零像素依赖(`renderer/frame.rs` 绘制顺序:output_pass 在前、Deep2d 在后直写 surface)。

落地 `content_profile::planeless` / `skip_forward_targets` 判据(实例与探针两道否决)
并接入 `ContentProfileReport`,在启动报告输出 `native content profile: ...`。
5 项测试锁定,含字节口径断言(44 B/px、1280x720 约 40MB)。

**诚实声明**:本批只交付测量与判据,**未改变任何帧路径行为**;真正跳过前向目标需
重排 output_pass 绑定,属独立切片,需真实窗口像素对比与双主题闭环。

## 验证汇总(合并态)

| 检查 | 结果 |
| --- | --- |
| Native 全量 | **862 通过 / 0 失败 / 60 GPU 忽略**(交接态 826/0/59,净增 36 项) |
| `cargo check --all-targets` | 0 warning |
| 真实 GPU 静态包 | initial/zoom/reset/tooltip/clear 全过,scopes/callbacks clean |
| 真实 GPU sim 包 | 8 阶段(含 backlog 追赶、GPU 失败恢复、取消)全过,clean |
| 真实 GPU 键盘 smoke | 6 阶段全绿,clean |
| repository gate | 通过 |
| 源码体量门禁 | 4340 文件通过(800 行无豁免) |

新增测试合计 20 项:宿主接线 5、传输记账 2、data_source 6、emphasis 2、P1-09 判据 5。

## 未覆盖(诚实条款)

- P1-02 宿主接线**未跑真实换包窗口注入**(需要连续换包场景与包切换通路)。
- 浏览器交互遍历与双主题视觉闭环(V-02)本轮仍未做——本会话产出全部为 Rust 侧
  与探针,未触碰 Web/UI 像素。
- P1-09 前向目标跳过、P1-08 区域上传、P1-05 chunk 直连:均为**测量后主动不做**,
  依据见各节;若后续规模进入 MB 级或 prepare 占比变化,应重估。