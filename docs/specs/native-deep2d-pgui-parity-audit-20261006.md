# Native Deep2D 核心能力对标盘点(GPUI / gpui-fast / Zed 口径,2026-10-06)

> 用户指令:native 2D 核心能力对标盘点,产出报告不改代码。
> **对标口径更正(用户确认)**:任务原文"PGUI"系笔误,正确锚点 = **GPUI(Zed 编辑器的
> Rust GPU UI 框架)+ gpui-fast(Longbridge 保留模式改造)+ Zed 本体**。本报告全部对比
> 按此口径执行(见 §0)。
> 方法:只读码实证(`packages/deep-engine-native/src` 的 deep2d 全栈 + platform_text +
> shader_disk_cache + 根级 deep2d_* GPU 模块),辅以仓内 GPU 测试断言与 test-output 证据。
> 诚实条款见 §6:GPUI/Zed 侧能力描述为公开资料级锚点(未读其源码),逐项已标注。

---

## 0. 对标口径更正说明

任务原文按"PGUI = GPU 加速即时模式 GUI"假设给出 egui/Slint/ImGui/Chrome 候选解释;
协调方已更正:**PGUI 系 GPUI 笔误**,对标锚点为:

| 锚点 | 是什么 | 与 deep2d 的可比面 |
|---|---|---|
| **GPUI** | Zed 的 Rust GPU UI 框架(即时+保留混合、实体树+依赖跟踪) | UI 架构、失效粒度、文本渲染通道 |
| **gpui-fast** | Longbridge 对 GPUI 的保留模式改造:view 级依赖跟踪,静止帧 CPU 开销下降 80–94%(用户提供锚点) | 失效/重绘成本模型 |
| **Zed 本体** | 120fps 目标编辑器(帧时间 <8.3ms,用户提供锚点) | 文本渲染质量、编辑器能力面、性能档 |

产品形态注意:Zed 是编辑器产品,deep2d 是引擎内 2D 图表/大屏运行时。对标取
"**文本渲染质量与 UI 框架能力面**",不比产品功能。文本整形两侧同款库
(cosmic-text;Zed 同用 cosmic-text 系整形),可直接比。

---

## 1. 现状核查(六步,2026-10-06 执行)

1. **全仓 grep**:`deep2d` 全部命中点已定位——CPU 契约层 `src/deep2d/`(44 个 .rs,
   7238 行)+ 根级 GPU 全家桶 `src/deep2d_*.rs`(21 个文件,3821 行)+
   `src/platform_text/`(33 文件,含 raster/ 子目录)+ `src/shader_disk_cache/`(10 文件)。
   任务书写的 `deep2d_text_gpu/filter_glyph/scroll` 等模块名对应实际文件:
   `deep2d_text_gpu_tests.rs`、`filter_glyph_gpu_tests.rs`、`deep2d_clip_gpu_tests.rs`
   (scroll 高 DPI 裁剪)、`million_point_gpu_tests.rs`。
2. **契约层**:`src/deep2d/types.rs` + `command_types.rs` + `validate*.rs` 定义
   Deep2dDisplayList schema v1 与预算常量;与 web 侧 SharedDisplayContract 同源
   (filter_glyph_gpu_tests 直接反序列化 TS 产出的 content-display-list.json,证实
   wire 格式双端共用)。
3. **依赖**(Cargo.toml,全固定版本):cosmic-text =0.19.0(features: std+swash,
   与 Zed 同款整形栈)、wgpu =30.0.1、winit =0.30.13、unicode-segmentation =1.13.3、
   bytemuck =1.25.2。**无** skia/raqote/rustybuzz 直依赖(整形由 cosmic-text 内部完成)。
4. **消费方**:app 侧 chart.rs / dashboard.rs / text_scale.rs / annotations.rs /
   annotation_input.rs 消费 painter 与 TextRasterizer;dashboard_runtime/
   input_text_paint.rs、input_text_layout.rs 消费 rasterize_styled;text_raster_cli.rs
   以 `--rasterize-text` / `--rasterize-text-batch` / `--measure-glyph-run` 对 web 提供
   文本服务;shader_disk_cache 服务 DeepShaderPackageV2 管线缓存。
5. **测试与证据**:GPU readback 测试 8 族(全部 `#[ignore]` 真 GPU 门)
   + CPU 单测 40+ 文件;test-output/ 下 `dashboard-text-batch-benchmark-20260918/
   evidence.json`(批处理基准实数)、`filter-glyph-run-20260918/`、
   `dashboard-text-density-*-20260918/`(PNG 截图矩阵)、`deep2d-codex-*-20260918.log`。
6. **规格文档**:`docs/specs/ts-rust-parity-audit-20261005.md`(双端能力一致性盘点,
   native 渲染 40 项金样分布 10 full/6 degraded/21 absent,本文不重复其内容,只做
   GPUI/Zed 口径的 2D 纵深);无既有 GPUI 对标文档(本报告为首份)。

---

## 2. deep2d 全栈能力矩阵(逐模块,全部读码实证)

### 2.1 文本渲染(GPU 通道)

| 能力 | 状态 | 证据 | GPUI/Zed 差距 |
|---|---|---|---|
| Per-glyph 图集渲染(TS 契约流) | **有** | `platform_text/raster/measure.rs::measure_glyph_run`:cosmic-text 逐行整形→swash 逐字形 R8 coverage→atlas 打包→UTF-16 簇映射;`filter_glyph_gpu_tests.rs` 真 GPU readback 证明 TS 产 baked_glyphs 落像素(消融 diff:同表去文本对比,填充无法伪造) | 对齐路径已通;但 native 自有 lane 不走它(见下行) |
| Native 自有 lane 文本 | **整段位图** | `raster/shaping.rs::rasterize` → 整段 RGBA(≤2048×2048)→ `image_layer.rs::into_display_list` 转为 Image/Atlas quad → GPU 贴图 | Zed 为 per-glyph atlas + GPU 合成;deep2d 自有 lane 整段贴图,DPI/缩放变化需重排重光栅 |
| glyph shader | 有 | `assets/shaders/native_deep2d_atlas_v1.wgsl`:`color.a * sampled.r`(R8 alpha mask × 单色),uv_bounds clamp,Nearest/Linear 采样 | 无 SDF、无亚像素三通道、无 slash-zero 等渲染选项 |
| 失败候选回滚 | **有(强项)** | `deep2d_text_gpu_tests.rs`:越界 glyph source 的 stage_update 被拒(`Glyph source` 错误),活动 painter 保持原帧 | GPUI 无等价事务语义(场景不同);对仪表盘可靠性是加分 |
| 文本命中/UTF-16 契约 | 有 | measure.rs:byte→UTF-16 偏移映射;`validate_text.rs` 预算校验 | — |
| 整形库 | **与 Zed 同款** | cosmic-text 0.19 `Shaping::Advanced`(整形)+ swash(光栅) | shaper 层面对齐;差异在下游(见 2.2–2.4) |

**缺字策略**:`glyph_id == 0` 一律硬错误(shaping.rs:52、styled.rs、measure.rs)——
没有 tofu 回退渲染。可交付性上诚实(宁可报错不画空),但与 Zed 的逐簇回退链相比
用户可见是"文本消失+报错"而非"降级显示"。

### 2.2 抗锯齿与画质

| 能力 | 状态 | 证据 | 差距 |
|---|---|---|---|
| 文本 AA | **灰度 AA(swash coverage)** | R8Unorm coverage atlas;`measure.rs` 取 `image.placement` 位图 | 无 LCD 亚像素(ClearType 类);Zed/Chrome 均以灰度为主流档,此项**基本对齐**;deep2d 无亚像素可选档 |
| 路径/形状 AA | **无** | `deep2d_gpu.rs:513` `multisample: Default::default()`(=1 采样);`native_deep2d_v1.wgsl` fragment 直出 flat color,无 coverage/SDF/feather;路径全靠 CPU 细分(`painter_path.rs`:曲线容差 0.25 物理像素、上限 16384 段、深度 24) | **最大画质差距**:几何边缘硬锯齿。GPUI 用 SDF/圆角 rect shader,Chrome/Skia 有解析式 coverage AA |
| 整数/非整数缩放 | 非整数可放大 | letterbox uniform(`native_deep2d_v1.wgsl::logical_to_ndc`);atlas 采样 Nearest 或 Linear | 非整数倍下文本位图被线性拉伸→发糊;Zed 按 DPI 精确重排 |

### 2.3 文本排版/复杂文字

| 能力 | 状态 | 证据 |
|---|---|---|
| 图形簇(UAX#29) | 有 | `layout.rs::grapheme_clusters`(unicode-segmentation);测试:国旗对+组合符为 1 簇、4 字节 emoji 1 簇 |
| 换行(简化 UAX#14) | 有 | `layout.rs::can_break_before/layout_lines`:CJK 逐字断、拉丁空格断、行首标点禁则(。,、;:!?)》与行尾开括号( [ { 《);`styled.rs` 另走 cosmic-text 原生 Wrap(None/Word/Glyph/WordOrGlyph) |
| RTL/阿拉伯文整形 | **整形层有** | `raster/frozen_windows_tests.rs::rtl_and_mixed_chinese_runs_use_only_explicit_frozen_faces`:希伯来语 locale + 混排,经 cosmic-text Advanced 整形;`annotation_input.rs` 测试含希伯来文 commit |
| Bidi 段落级重排(自有纯排版层) | **无(明示超出范围)** | `layout.rs` 头注释:"Shaping, fallback fonts and bidi reordering stay explicitly out of scope";`text_document_types.rs:18`:"不执行 bidi,只记录意图" |
| 颜色 emoji | **无** | 光栅回调单色(`shaping.rs::draw` 固定 request.color);swash R8 coverage 无 COLR/CBDT 合成路径;emoji 仅作为**簇**(光标粒度)被测试,渲染层无彩色位图通道 |
| 可变字体 | **仅检测** | `frozen_fonts.rs:92`:`font.as_swash().variations().next().is_some()` 只判"是否可变",不应用 wght/opsz 轴 |

### 2.4 编辑器能力(platform_text 编辑族)

| 能力 | 状态 | 证据 |
|---|---|---|
| 光标/选区(簇粒度) | 有 | `text_edit.rs::TextEditState`:caret+anchor 全部落在簇边界;Move 8 向(含 Word/Line/Doc);测试"emoji 是一次 Right" |
| 撤销/重做 | 有 | 有界快照栈(max_history),`history_depth` |
| IME(中文输入) | **有(状态机+真窗)** | `ime.rs`(begin/update/confirm/cancel)+ `ime_winit.rs`(winit Ime 四事件→PreeditChanged/Committed/Cancelled,commit 走 replace_selection 可撤销,失败保留预编辑);`app/annotation_input.rs` 在真实窗口消费 Ime 事件(测试含 "wen"→"温" 中文、ZWJ 家庭 emoji、希伯来文);`app/annotation_ime_area.rs` 设候选窗位置;`platform_text/ime_session*.rs`+`ime_trace_tests.rs` 中文/emoji/组合符全链路 trace |
| 富文档模型 | 有 | `text_document*.rs`(6 文件):StyleSpan 簇区间样式、Paragraph 对齐、InlineObject 占位簇、TextChange 修订增量、invariant/validation 测试 |
| 点→光标反查(hit-to-caret) | **无** | 全域无 inverse mapping API(`hit_index.rs` 只做命令级命中,不做字形级);dashboard 输入框靠 `input_text_layout.rs` 按整段宽度的启发式 |
| 选区/预编辑的 GPU 绘制原语 | 部分 | 无专用选区高亮原语(只能用通用 Path quad 拼);预编辑文本由宿主绘制 |
| 多行编辑器部件/软换行滚动 | 无 | 编辑器是状态机+适配器,无逐行视口布局部件 |

### 2.5 路径/描边/裁剪(CPU 几何)

| 能力 | 状态 | 证据 |
|---|---|---|
| 曲线展平 | 有 | `painter_path.rs`:容差 0.25 物理像素,自适应深度(≤24),上限 16384 段 |
| 填充三角化 | 有 | `painter_polygon.rs::triangulate_simple_polygon` + `painter_polygon_bridge.rs`;自交/交叉子路径拒绝(`painter_path_intersections.rs`) |
| 描边 | 有 | `painter_stroke.rs`(274 行)+ `stroke_caps.rs`(端帽)+ `painter_dash.rs`(虚线,含归一化相位) |
| 裁剪 | 有(多边形剪刀) | `painter_clip.rs`:clip 路径三角化后逐三角形裁剪顶点;预算 MAX_CLIPPED_VERTICES=2M、MAX_CLIP_PAIR_TESTS=4M;GPU 侧 `deep2d_scissor.rs` 逻辑矩形→物理 scissor(向外取整,letterbox 同源映射;测试含 1200×800 窗口偏移用例) |
| GPU clipPath 像素证据 | 有 | `deep2d_path_clip_gpu_tests.rs`:RTX readback 证明 clipPathIds 限制实际绘制像素 |

注:裁剪是"剪刀矩形 + CPU 多边形裁剪"两档;**没有** GPU 模板缓冲/stencil 路径,
也不支持嵌套任意混合裁剪(clip 必须单一闭合简单子路径,painter_clip.rs:44 校验)。

### 2.6 Atlas 与缓存

| 能力 | 状态 | 证据 |
|---|---|---|
| 图集上传 | 有 | `deep2d_atlas_gpu.rs`:R8Unorm/Rgba8UnormSrgb,设备 2D 尺寸上限预检,**像素内容 hash 键控**复用,Nearest/Linear 采样 |
| GlyphAtlasBook(增量图集合同) | 有(合同层) | `glyph_atlas.rs`:shelf 装箱、4096 cell 上限、pending region 增量矩形、同像素幂等零上传、最老一半驱逐、resource_revision;**注意:place_text 是"每段文本一格"**,per-cluster 格子注释明言 "remain a later tranche" |
| 跨帧资产缓存 | 有 | `deep2d_gpu_cache.rs`:frame layout/uniform、按格式管线、atlas 纹理(≤16)、顶点缓冲(≤32),LRU 驱逐,hit/create 计数器可观测 |
| CPU 路径缓存+依赖图 | **有(强项)** | `painter_cache.rs`:LRU(4096 条/8MB),EntryWitness(epoch/camera_scale 位模式)依赖失效,**7 类 miss 归因**(camera/epoch/structure/clip/resource/style/evicted);`painter_cache_dependency_tests.rs` 225 行锁定;witness 与细分缩放同源(`CameraWitness`,防 -0.0/NaN 歧义) |
| 增量顶点传输 | **有(强项)** | `deep2d_vertex_transfer{,_plan,_stats}.rs`:内容 hash 复用→CPU 影子快照→区域 diff→copy_buffer_to_buffer 增量;阈值(16KB 最小拷贝/64 命令/8MB 影子);**6 类归因**(content_reused/incremental_copies/no_previous_frame/previous_not_copyable/plan_rejected/below_copy_threshold);真 GPU 测试断言部分改动 uploaded<total/2 且 copied>total/2、乱序/同内容零上传 |
| 事务式更新 | 有 | `deep2d_gpu.rs::stage_update`:候选失败保持活动帧(text/clip/atlas 三处 readback 测试均覆盖) |

### 2.7 帧组织/层级/合成

| 能力 | 状态 | 证据 |
|---|---|---|
| 有序单 pass 绘制 | 有 | `deep2d_gpu.rs::draw_internal`:chunk 序列,Path/Atlas 两管线切换,per-chunk scissor,Layer 交错(deep2d 层与 Windows 视频 slot 按层序交织) |
| 合成层 | 有 | `deep2d/runtime_composite{,_prepare}.rs` + `runtime_layers.rs::build_chunks`;ZOrdered 组合 |
| 绘制证据 | 有 | `deep2d_draw_evidence.rs`:DrawEvidenceTracker + atlas inventory,`DEEP_DASHBOARD_FILTER_EVIDENCE` 开关输出 prepare/resources/evidence 毫秒 |
| 百万点管线 | 有 | `million_point_gpu_tests.rs`:1M 驻留→visible_slice→decimate 至 10 万绘制预算(EqualStrideFirstLast)→渲染→GPU draw+readback,分阶段诚实计时打印 |

### 2.8 多线程

| 能力 | 状态 | 证据 |
|---|---|---|
| prepare/tessellation 并行 | **无** | `Deep2dPathCache` 为 `Arc<Mutex<>>`,prepare 在锁内串行(deep2d_gpu.rs:148-159);无 rayon/工作划分 |
| 文本整形后台化 | **无** | TextRasterizer 为 `&mut self` 独占;批量 `raster_batch.rs` 是同请求内的串行循环(仅共享整形状态复用) |
| 跨线程内容投递 | 有(宿主侧) | app 层 packet_mailbox/watch_thread(非 deep2d 域,不计入能力) |

### 2.9 shader_disk_cache(管线缓存)

- 有:put/get/remove + 取消令牌(`ShaderDiskCacheCancellation`)、LRU access_sequence、
  容量门(64 条/64MB,types.rs 默认)、scope 五元组(namespace/package schema/target
  profile/compiler version/shader ABI id+hash)、损坏记录恢复(`as_corrupt_record`,
  recovery_tests.rs 9937 字节)、schema 化记录(deep.shader-disk-cache v1)。
- 对标注:Zed/GPUI 公开资料无同级 shader 磁盘缓存承诺;此项为 deep2d 侧**超出**
  对标锚点的基础设施(cold-start 收敛用),与 wgpu 自身 pipeline cache 并行存在。

### 2.10 已有性能数字(全部来自仓内断言/证据文件,非本次实测)

| 数字 | 来源 |
|---|---|
| 百万点:decode 与 slice+decimate 各 <5s(硬断言);GPU prepare+draw 计时打印不设门 | `million_point_gpu_tests.rs:171-176` |
| 绘制预算:每帧 10 万顶点(注释:参考 GPU 上单帧内) | `million_point_gpu_tests.rs:15` |
| 批量文本:6 请求两轮,single 29056ms/19842ms vs batch 5139ms/4538ms(≈5.7×),像素与回执逐字节相等 | `test-output/dashboard-text-batch-benchmark-20260918/evidence.json` |
| 顶点增量:部分改动 uploaded<total/2 且 copied>total/2;命中 127/miss 1 | `deep2d_vertex_transfer_gpu_tests.rs:61-63`、`_budget_tests.rs:41-43` |
| 文本上限:整段光栅 ≤2048×2048、文本 ≤16KB、字号 1–256;styled ≤16384 行/65536 字形;批量 ≤512 请求/64MiB 像素;glyph measure 有 MAX_CELLS 上限 | shaping.rs/styled.rs/raster_batch.rs/measure.rs |
| 显示列表预算:资源 65536、命令 262144、路径动词 2M(单资源 1M)、clip 64/命令、文本码元 4M | `deep2d/mod.rs:67-76` |

---

## 3. GPUI / gpui-fast / Zed 对标矩阵

> 对标侧事实为公开资料级锚点(用户提供 + 业界通识,未读其源码验证,标注〔锚〕);
> deep2d 侧全部为读码实证。评级:✅ 对齐 / 🟡 部分 / ❌ 缺失 / ➖ 形态不同不硬比。

| # | 能力面 | GPUI/Zed〔锚〕 | deep2d 现状 | 评 |
|---|---|---|---|---|
| 1 | 整形 shaper | cosmic-text(与 deep2d 同款) | cosmic-text 0.19 `Shaping::Advanced`,全部文本路径统一 | ✅ |
| 2 | per-glyph GPU 图集 | glyph atlas 常驻 GPU | **契约流有**(measure_glyph_run→TS baked_glyphs→atlas shader);**native 自有 lane 无**(整段位图贴图;GlyphAtlasBook per-cluster 未接线) | 🟡 |
| 3 | 亚像素/灰度 AA | 灰度为主,subpixel 可选 | 文本灰度 AA(swash R8);无 subpixel 选项 | 🟡 |
| 4 | 路径/几何 AA | GPU 端圆角/SDF/feather | 无 MSAA(1×)、flat-color 三角形,CPU 0.25px 细分 | ❌ |
| 5 | 颜色 emoji | swash color 位图通道 | 无 COLR/CBDT 合成;缺字即硬错误 | ❌ |
| 6 | 双向文/复杂脚本 | cosmic-text 全链(bidi+连字) | 整形层同款(frozen RTL 测试过);**纯排版层与编辑器光标移动无 bidi**,Paragraph 只记方向意图 | 🟡 |
| 7 | 可变字体 | 支持轴应用 | 仅 `variations()` 存在性检测,不应用轴 | ❌ |
| 8 | 字体回退链 | 嵌入字体+逐簇回退 | frozen 显式字体集+locale db;缺字硬错误;内嵌字体刻意不做(许可保守,font_capability 已备审计结构) | 🟡 |
| 9 | 光标/选区/撤销 | 全量 | 簇粒度光标/选区/8 向移动/有界撤销栈 | ✅(状态机层) |
| 10 | IME 中文输入 | 全平台 IME | winit Ime 四事件适配+候选窗定位+真窗标注输入(中文测试过)+UIA 无障碍通路 | ✅(winit 覆盖面) |
| 11 | 点→光标反查 | 编辑器标配 | 无字形级反查 API;dashboard 输入框启发式 | ❌ |
| 12 | 失效粒度 | gpui-fast:view 级依赖跟踪,静止帧 CPU −80~94%〔锚〕 | 命令级路径缓存(witness 依赖图+7 类归因)+内容 hash 顶点增量;**无元素级脏跟踪**,内容更新仍全量 prepare(缓存摊薄) | 🟡(机制不同:deep2d 是"内容寻址缓存"路线,静止无更新时 draw 路径零 CPU prepare——按 `last_physical_size` 跳过 uniform 上传、chunk 直放,但无 gpui-fast 的依赖图静态帧证明) |
| 13 | 性能档 | Zed 120fps / <8.3ms〔锚〕 | 无帧预算 CI 门;百万点 decode/decimate <5s 断言;GPU 计时仅打印;文本批量(大图)仍 ~850ms/请求 | ❌ |
| 14 | 多线程布局 | 后台布局线程〔锚〕 | prepare/整形单线程互斥串行 | ❌ |
| 15 | 窗口合成/多窗口/透明 | GPUI 混合成;无闪烁〔锚〕 | 单窗播放器形态(letterbox+视频层交织);设备丢失恢复/重试另有全栈(deep2d 域外) | ➖ |
| 16 | 渲染管线缓存 | 无同级承诺〔锚〕 | shader_disk_cache 全套(schema/scope/LRU/损坏恢复/取消) | ✅(超出锚点) |
| 17 | 事务式内容更新 | 无等价(产品形态不同) | stage_update 候选失败保活动帧,三类 readback 回滚测试 | ✅(超出锚点) |
| 18 | 可观测性 | Zed 有性能面板〔锚〕 | cache hit/miss 计数、6 类传输归因、7 类 miss 归因、DrawEvidence、prepare/resources/evidence 分段计时 | ✅ |

---

## 4. 差距 Top10(按工业数字孪生主线价值排序)

| # | 差距 | 对主线的影响 | 建议切片 | 工时级 |
|---|---|---|---|---|
| 1 | **路径/形状无 AA**(1× 采样、flat color) | 工业图表线/管路/截面边缘锯齿,大屏距离观看首因差评;山海鲸/帆软均为 AA 边缘 | 最小切片:4× MSAA render pass(wgpu multisample count=4+resolve);进阶:路径 SDF/coverage shader | MSAA 2–3 天;SDF 1–2 周 |
| 2 | **自有 lane 文本=整段位图**,DPI/缩放变化全量重光栅,非整数倍发糊 | 数字孪生大屏 DPI 混布与缩放是常态;文本重排卡顿直接掉帧 | 接线 GlyphAtlasBook per-cluster 到 GPU painter(合同层已备,差"later tranche"那一跳)+按 DPI 档量化光栅 | 1 周 |
| 3 | **点→光标反查缺失** | 仪表盘输入框/标注编辑无法精确点击定位;工业表单录入体验硬伤 | measure_glyph_run 已产 UTF-16 簇+placement,补 inverse binary search API + dashboard 接线 | 3–5 天 |
| 4 | **颜色 emoji 无渲染** | 大屏告警/状态文案中 emoji 常用(⚠/🔴);当前缺字直接报错 | swash `SwashContent::Color` 位图通道进 atlas(Rgba8 槽) | 3–5 天 |
| 5 | **无帧预算门禁** | 无法守护 60fps 主线承诺;性能回归只能靠人眼 | GPU 测试加帧时间硬断言(prepare+draw <8.3ms@参考 GPU)+ 连续 N 帧静默更新零重 prepare 断言(对齐 gpui-fast 静止帧卖点) | 2–3 天 |
| 6 | **可变字体轴不应用** | 同一字族多字重需打多份字体文件;工业字体包体积与许可面变大 | swash variations 设置 wght 轴 + font_capability 上报轴清单 | 2–3 天 |
| 7 | **编辑器/纯排版层无 bidi** | 阿拉伯/希伯来设备名+单位混排时光标移动与选区错乱(整形显示正确但编辑粒度错) | text_edit Move 走整形后 run 的 visual order(cosmic-text 已产,只需接线) | 3–5 天 |
| 8 | **prepare/整形单线程** | 大显示列表(数十万命令预算)换包瞬间卡顿 | prepare 按命令分片并行(rayon 或 scoped thread),cache 锁粒度改分片 | 1 周 |
| 9 | **批量文本光栅 CPU 慢**(batch 后仍 ~850ms/大请求) | 换包/首帧文本风暴时主线程阻塞 | swash raster 结果 LRU(现有 image_cache>4096 全清的粗粒度换新改为真 LRU)+ 与 #8 并行化 | 3–5 天 |
| 10 | **内嵌字体路径缺失** | 交付环境字体不可控(工控机裸系统);当前缺字=硬错误 → 文本消失 | font_capability 数据结构已备(Embedded/LicenseStatus/usable_in_artifact),补打包+子集化+许可确认流 | 1 周(含许可决策) |

排序依据:工业数字孪生主线的可视质量(1/2)→ 交互完整性(3/4)→ 性能承诺(5/8/9)→
交付健壮性(6/7/10)。

---

## 5. 结论速览

- **强项(已达或超出 GPUI/Zed 同位能力)**:cosmic-text 同款整形、簇粒度编辑器状态机
  +IME 全链(中文实测)、内容寻址跨帧缓存 + 依赖图失效归因 + 增量顶点传输、事务式
  更新回滚、shader 磁盘缓存、绘制证据/归因可观测性。这些在生产级可靠性维度是真实的
  工程优势。
- **主差距集中在三个面**:**像素质量**(无路径 AA、无颜色 emoji、非整数缩放发糊)、
  **文本运行时架构**(自有 lane 整段位图 vs per-glyph atlas)、**性能纪律**(无帧预算
  门禁、单线程 prepare)。三者均有明确切片路径,合同层与数据结构大多已备,主要是
  "接线"与"门禁"工作而非从零建设。

## 6. 诚实条款(未验证/未覆盖项)

1. 本报告**未运行任何 cargo test / GPU 测试**;所有性能数字来自仓内断言源码与
   test-output 既有证据文件(已注明路径),非本次复测。
2. GPUI/gpui-fast/Zed 侧描述为**公开资料级锚点**(用户提供 + 业界通识),未克隆
   读其源码;凡属此类均标〔锚〕。若需逐行对拍(如 gpui-fast 依赖图实现细节),
   需另行任务。
3. `#[ignore]` 真 GPU 测试族(million_point/text/clip/vertex_transfer 等)在本次
   环境未执行;其"已实现"评级基于测试代码断言 + test-output 历史证据
   (deep2d-codex-*-20260918.log 等显示历史真机跑过),非当前机器复现。
4. 颜色 emoji"无"的结论基于:光栅回调单色 + R8 coverage + 无 COLR/CBDT 代码路径
   (读码否定);未做真机 emoji 渲染实验复证。
5. web 侧 Deep2D 图表运行时(对比锚)本轮未读码;双端文本质量差异对比引用
   `docs/specs/ts-rust-parity-audit-20261005.md` 的金样结论,未重验。
6. 工时级为读码推算的经验档(未开工估算),非承诺。
