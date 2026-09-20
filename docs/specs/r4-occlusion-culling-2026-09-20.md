# R4 遮挡剔除(GPU-driven)——判定与消费链设计

> 状态:第四切片(尾巴项收口:空批次 draw 跳过、逐实例 mip 定档、校准钩子)完成;
> 精度-召回联测、可见性缓冲两阶段管线、相机前推运动补偿 = 下一切片。
> 权威计划:`docs/specs/industrial-3d-format-work-plan-2026-09-16.md` 不涉及本主题;
> 路线锚点:`docs/specs/de26-master-execution-roadmap-2026-09-19.md` 第 7 节 #2。
> 证据:`test-output/r4-occlusion-consume-20260920-r1/evidence.json`、
> `test-output/native-hiz-20260920-r1/evidence.json`、
> `test-output/r4-tail-closure-20260919-r1/evidence.json`(本文所有实测
> 数字均来自该文件与 `cargo test --ignored` 实跑输出,可复现命令见 §5)。

## 1. 背景与切片划分

- **首切片(5f13372,已合入)**:`native_gpu_occlusion_v1.wgsl` 输出 per-instance
  u32 可见标志(视锥∧遮挡,全步定序、无原子);`gpu_occlusion.rs`
  (OcclusionSource/GpuOcclusionStage/OcclusionReadback);`gpu_culling.rs::attach_occlusion`。
- **本切片(第二刀)**:消费该标志,打通「遮挡判定 → 紧凑化 → indirect draw」闭环:
  `native_gpu_occlusion_compact_v1.wgsl`(5 entry point 定序链)+
  `gpu_occlusion_consume.rs`(OcclusionConsumeStage)+ `gpu_culling.rs::attach_occlusion_consume`
  + 主视锥 draw 访问器切换。
- **第三切片(本切片,2026-09-20)**:生产接线落地——`renderer/hi_z_pyramid.rs`
  (MSAA 深度 resolve → r32float min 金字塔)+ init/resize/scene_update 三处挂载
  (显式开关默认关)+ 主视锥 draw 真正消费紧凑输出,详见 §6。
- **下一切片**:精度-召回联测(含像素级 ground truth)、可见性缓冲两阶段管线、
  相机前推运动补偿;逐实例 mip 定档与空批次跳过已在第四切片落地(§7)。

## 2. 架构

### 2.1 三档串联(GpuCulling::encode 内顺序)

```
frustum pass(逐视锥,atomicAdd 追加紧凑)
  → occlusion pass(主视锥 HiZ 判定,flags = 视锥∧遮挡)
  → consume 链(5 kernel,消费 flags,产出主视锥紧凑 draw 输出)
```

### 2.2 消费链五个 kernel(全定序、无原子、无共享内存)

| kernel | 输入 → 输出 | 说明 |
|---|---|---|
| `scan_blocks` | flags → block_sums | 每 invocation 固定负责一个 64 实例块,升序累加 |
| `scan_block_offsets` | block_sums → block_offsets | 单 invocation 升序独占前缀扫描 |
| `scan_instance_prefix` | flags+block_offsets → prefix[N+1] | 每实例 = 块偏移 + 块内升序前缀;末实例补写总数 |
| `compact_instances` | flags+prefix+source+metadata → compact_visible | 槽位 = `instance_start + (prefix[id] − prefix[批次首])` |
| `write_indirect` | prefix+batch_ranges → compact_indirect | `instance_count = prefix[批末] − prefix[批首]` |

- 复杂度(如实):块内前缀 O(64)/实例;`block_offsets` 为单线程 O(block_count)
  顺序扫(预算 1,048,576 实例时 block_count=16384,常数量级),换取零原子。
- 确定性:所有归约按下标升序固定方向;输出是输入的位级确定函数(测试:
  两次完整 encode→readback 紧凑行逐字节一致)。

### 2.3 选型:为什么不是「并入 frustum pass 的 visible 判定」

1. frustum pass 是 per-view(主视锥 + N 级联),HiZ 金字塔仅属主相机;并入需 per-view
   分支,破坏首切片「frustum 先、遮挡后、逐位一致重放」契约。
2. frustum 紧凑用 `atomicAdd`(追加序不定);并入则消费链继承原子,违反本切片
   「全定序、无共享内存原子」门禁。
3. 独立链让 frustum 输出保留给阴影视锥(view ≥ 1)与下一切片可见性缓冲复用;
   遮挡判定(首切片)与紧凑消费(本切片)可独立演进。

### 2.4 消费点:draw 侧零改动

draw 仅经两个访问器消费紧凑输出(`gpu_scene_draw.rs::draw_indirect`):

```rust
culling.visible_instances(view)   // vertex buffer slot 1,按 instance_start×144 切
culling.indirect(view)            // draw_indexed_indirect,20B/批次
```

`GpuCulling` 访问器规则:**view 0 且挂载消费链 → compact_visible/compact_indirect;
view ≥ 1(阴影级联)→ 恒 frustum 输出**。compact 行槽与 frustum 输出逐槽兼容
(144B 行、批次区域基址),draw 代码与行布局零改动。

### 2.5 与 LOD / Blend 的边界

`prepare_gpu_culling` 中 LOD 批次与 Blend 批次 mask=0 → flags 恒 0 → 其批次
`instance_count=0`;LOD 走 `GpuLod` 自身缓冲、Blend 走排序 direct 路径,均不消费
紧凑输出,互不影响。

## 3. 实测(4096 实例,RTX 4060 Laptop / Vulkan / wgpu 30.0.1)

### 3.1 计数一致性(遮挡判定 → 紧凑输出)

| 场景 | 实例 | frustum | 遮挡 flags | 紧凑 | per-batch | draws |
|---|---|---|---|---|---|---|
| A 全在视锥 | 64 | 64 | 64 | 64 | [64] | 1 |
| B 全遮挡 | 64 | 64 | 0 | 0 | [0] | 0 |
| C 混合深度 | 128 | 128 | 64 | 64 | [64] | 1 |
| D 双批次内容对照 | 128 | 128 | 64 | [64, 0] | [64, 0] | 1 |
| 4096 混合深度 | 4096 | 4096 | 2048 | 2048 | [2048, 0] | 1 |

- D 场景内容级验证:批次 0 幸存行与 CPU 参考行(instance 0..64 按 id 升序)
  **逐字节一致**;批次 1 区域槽位保持零(不被触碰)。
- 失败路径:未挂遮挡判定时 `attach_occlusion_consume` 返回 Err(不静默空转)。

### 3.2 时间对照(21 轮交替采样,丢 5 预热,16 样本中位;CPU 墙钟 = encode+submit+poll)

| 配置 | run 1 | run 2 | run 3 |
|---|---|---|---|
| 全量(空编码器提交下限) | 203.3 µs | 162.1 µs | 150.7 µs |
| frustum-only | 276.3 µs | 284.2 µs | 219.3 µs |
| +遮挡判定(首切片链) | 382.5 µs | 314.4 µs | 277.4 µs |
| +遮挡+消费链(本切片) | 541.6 µs | 524.2 µs | 443.0 µs |

- 口径(如实):CPU 墙钟,非 GPU timestamp;小负载下提交路径主导,数字含与开发
  会话并行的负载噪声(全样本保留在 evidence.json);「全量」无剔除路径的 draw 侧
  开销在 compute harness 中不可测,以提交下限 + 幸存实例数换算呈现。
- 工作量削减:主视锥幸存实例 4096 → 2048(**50%**),每实例 36 索引(12 三角形)
  的顶点/光栅化工作量等比减半;病态放大守卫(consume < frustum×5 + 5ms)通过。
- 局限(如实):`instance_count=0` 的批次现仍发起 `draw_indexed_indirect`(空栅格化
  但有驱动开销);真正的 draw 调用数减少需渲染接线后的批次跳过(下一切片)。

### 3.3 回归

- lib 429 passed(基线不变);bin 162 passed + 66 ignored(基线 161 + 新契约冻结测试);
  gpu_culling 7/7(含新增 batch_ranges 单测)、gpu_lod_draw_readback 31/31、
  gpu_shader_material_draw 28/28、surface_flags 5/5。
- GPU(`--ignored`):消费链 4 用例 + 首切片 5 用例全过。
- 外部失败(bloom_contract、cascaded_shadow、compat_x_*、runtime_package_x)不在本
  切片改动闭包内;归因并行会话推进 HEAD(fbc6d6e)与其工作树修改——基线 worktree
  复验时 HEAD 本身无法编译(并行未完成重构),详见 evidence.json `regression`。

## 4. 纪律与预算

- 文件体量:wgsl 105 行 / consume 383 行 / consume 测试 405 行 / gpu_culling 421 行
  (全 ≤800);WGSL sha256 见 evidence。
- 确定性门禁:契约冻结测试机械断言 WGSL 无 `atomic`、无 `var<workgroup>`、
  5×`@workgroup_size(64)`。
- wgpu 限制处置:`max_storage_buffers_per_shader_stage` 默认 8 → 按 entry point 拆分
  bind group;read/write 资格按 WGSL 声明匹配(非实际用法)。

## 5. 复现

```bash
cd packages/deep-engine-native
cargo test --lib                                    # 429 passed
cargo test --bin deep-engine-native                 # 162 passed
cargo test --no-fail-fast --test gpu_culling        # 7 passed
cargo test --bin deep-engine-native consume_ -- --ignored --nocapture   # 消费链 GPU 用例
cargo test --bin deep-engine-native gpu_occlusion_tests:: -- --ignored  # 首切片回归
```

## 6. 第三切片:HiZ 生产接线(2026-09-20,原 §6.1/6.2 落地)

> 证据:`test-output/native-hiz-20260920-r1/evidence.json`(本文数字均出自该文件与
> 实跑日志;RTX 4060 Laptop / Vulkan / wgpu 30.0.1)。

### 6.1 转换方案(审计结论)

`copy_texture` 双重不可行(multisampled 禁 `COPY_SRC` + 格式须一致);
render pass `resolve_target` 不支持深度。**采用**:第 0 层 = 一次全屏 render pass,
`texture_depth_multisampled_2d` 4 样本**定序 min**,颜色写入金字塔 mip 0
(r32float);第 1 级起 `include_str!` 逐字复用已认证 DCIR 工件(min 变体),
anchored/variable 选择与 TS `encodePasses` 一致。提取内核
`native_hi_z_extract_v1.wgsl` 手写(MSAA 深度超出 DCIR v0 合同,与 TS copy 内核
同一理由);免中间 depth32float 与 `frag_depth`。mip 层数公式
`floor(log2(max(w,h)))+1`、±0 规范化均与 TS 对拍。

### 6.2 帧序与挂载契约

```
SceneResources(culling.encode:frustum → 遮挡 → 消费 dispatch,消费上一帧金字塔)
  → Shadow → Opaque(深度 Store)→ HiZ(提取 + 缩减)→ Transparent → …
```

- 挂载三处同一契约:`init`(创建)、`resize`(金字塔重建 + 重挂)、
  `scene_update` Replace(packet 重建 + 重挂;不重挂会静默丢链)。
- 显式开关 `DEEP_ENGINE_NATIVE_OCCLUSION_HIZ=1`,**默认关**。
- `encode_opaque_pass` 新增 `retain_depth`:HiZ 挂载时 opaque 深度必须
  Store(否则 Discard → 提取读未定义深度)。
- 遮挡判定按首切片合同采样**顶层**(1×1);OcclusionSource 必须给**全 mip 链
  视图**——内核 `textureLoad(hiz, coord, dims.w)` 按视图内绝对层号读,单层视图
  越界读 0 → 全剔(GPU 对照测试暴露并修复)。
- 金字塔创建/重建时全链填充远平面:首帧 dispatch 读 wgpu 零初始化(0.0 = 最近)
  会整体误剔(真实窗口冒烟实测 visible=1/3,修复后 3/3)。

### 6.3 实测

| 项 | 结果 |
|---|---|
| GPU 对照(合成深度) | 提取+anchored 链与量化期望逐位一致;variable 链与 CPU 变窗参考逐位一致;真实金字塔喂判定:全屏遮挡体 64→0,远平面 64→64 |
| 真实窗口冒烟(遮挡 fixture) | 帧 1:3/3(不误剔)→ 帧 2-4:2/3(墙后立方体被剔);submission scopes=clean |
| 真实窗口冒烟(默认 fixture) | 帧 1:4/4 → 帧 2-4:1/4:顶层采样对屏幕重叠实例过度剔除(精度极限的定量证据,见 §6.4) |
| 性能 1080p 墙钟 | 提取+10 级缩减全链:三跑中位 819/776/753 µs(含提交,如实标注) |
| 生产帧 GPU timestamp | telemetry smoke `gpu.hi_z` 段 p50=34.8µs(64×64 窗口);`cpu.hi_z` p50=16.4µs;1080p GPU timestamp 待真实分辨率窗口 |
| 回归 | lib 430 passed;bin 165 passed + 70 ignored;gpu_culling 7/7、gpu_lod_draw_readback 31/31、gpu_shader_material_draw 28/28、surface_flags 5/5;gpu_occlusion+consume GPU 用例全过 |

### 6.4 纪律与剩余缺口(下一切片)

- 文件体量:hi_z_pyramid.rs 572 / hi_z_pyramid_tests.rs 353 / extract wgsl 45
  (全 ≤800);遥测 QUERY_COUNT 12→16,decode 数组长度改用 `GpuSegment::ALL.len()`
  (原硬编码 6,挂载后越界 panic,已修复)。
- **顶层采样精度极限(定量)**:屏幕重叠场景(默认 fixture)帧 2 起 4→1——
  1×1 texel 的 min 是全屏 min,非全屏遮挡体也会压低 scene_min。恢复精度必须
  逐实例 mip 定档(TS `hiZOcclusionMip` 等价物)+ 精度-召回联测;**定档前开关
  保持默认关**。
- 上一帧深度滞尾:相机大幅前推存在滞后误剔窗口(与 TS `previousHiZVisibility`
  同边界),1e-6 裕量不覆盖运动补偿。
- 空批次 draw 跳过(原 §6.3)仍开放;Replace 重挂路径经编译接线 + 同一挂载契约
  (C3 快路径不触发 Replace),未单独 GPU 冒烟。

## 7. 第四切片:尾巴项收口(2026-09-19,原 §7.1/7.3 落地)

> 证据:`test-output/r4-tail-closure-20260919-r1/evidence.json`(RTX 4060 Laptop /
> Vulkan / wgpu 30.0.1;所有数字出自该文件与实跑日志)。

### 7.1 逐实例 mip 定档(TS `hiZOcclusionMip` 同式)

- `native_gpu_occlusion_v1.wgsl`:足迹长边像素 `max(2·max(radius_px.x, radius_px.y), 1)`
  → `level = min(ceil(log2(longest_side)), top)`;粗层 texel = 区域 min,层内 rect
  由同一足迹折算、覆盖恒不小于细层足迹,保守性不变;NaN/inf 经 max/min 的非 NaN
  分支落 0 层/顶层,均在保守侧。
- `OcclusionParams.dims` 契约调整:y/z 语义改为第 0 层尺寸,w = 顶层上限;
  `OcclusionSource.mip_level` 语义改为「采样层上限」(生产传顶层;传 0 = 锁定
  mip 0,场景 D 的 rect 契约测试因此原样保持)。
- CPU 参考 `gpu_occlusion::footprint_mip_level` 与 WGSL 内联式、TS 三方逐值对拍
  (单测:TS 向量 (1,1,8)→0、(9,3,8)→4 + 夹紧/非有限分支)。
- **精度收益(真实窗口)**:默认 fixture(屏幕重叠实例)稳态幸存从顶层采样的
  1/4 恢复到 3/4;帧 2 的瞬时回落为「上一帧深度滞尾」已知边界。第 4 个实例是否
  真被遮挡无像素级 ground truth,如实存疑。
- **开关纪律**:`DEEP_ENGINE_NATIVE_OCCLUSION_HIZ` 仍保持默认关——精度-召回联测
  (含像素级 ground truth)未做,定档参数未联测标定。

### 7.2 空批次 draw 跳过(上一帧 compact 计数门控)

- `ConsumeReadbackMode::{Off, Counts, CountsAndRows}`:生产挂载走 `Counts`
  (每批次 20B 轻量读回),测试/诊断走 `CountsAndRows`。
- `GpuCulling.survivors`:上次取回的每批次 compact 计数;`update_views`
  (相机/resize)即失效回 None;`compact_batch_survivors(view, batch)` 仅在
  view 0 + 挂链 + 计数已知时返回 Some。
- `gpu_scene_draw::draw_selected` 非 LOD 分支:`Some(0)` → 不发起
  `draw_indexed_indirect`。计数是上一帧快照(与 HiZ「消费上一帧」同界);
  相机移动当帧失效 = 全画,无 pop-in。
- GPU 用例 `consume_metrics_feed_empty_batch_skip_gate`:candidates=128 /
  drawn=64 / culled=64 / draws=Some(1);survivors 逐批对齐 [64,0];view≥1 与
  update_views 后为 None。

### 7.3 查准/查全校准钩子

- `gpu_culling_readback::OcclusionCullMetrics { candidates, drawn, culled,
  draws: Option<u32> }` + `report()`;`GpuCulling::take_occlusion_metrics`
  排空 flags 与 compact 计数 readback 并刷新 survivors。
- `renderer/frame.rs` 帧尾输出 `native occlusion hiz: visible_instances=…
  frustum_candidates=… culled=… draws=…`(前两字段沿用旧口径,smoke/证据脚本
  前缀定位不受影响)。只观测,不做自动校准。

### 7.4 回归与外部失败

- lib 431 passed;bin 173 passed + 74 ignored;gpu_culling 7/7、
  gpu_lod_draw_readback 31/31、gpu_shader_material_draw 28/28、surface_flags 5/5;
  遮挡/HiZ/消费链 GPU ignored 用例全过(含新增门控用例)。
- 真实窗口冒烟(开关开/关三组):遮挡 fixture 帧 1 = 3/3、帧 2-4 = 2/3
  (与第三切片一致);开关关闭 = 零条指标行、scopes=clean(零回归)。
- 既有外部失败(bloom_contract、cascaded_shadow、compat_x_*、runtime_package_x)
  与本切片改动闭包无交集:其读取的全部文件与 HEAD 逐字节一致,归因并行会话
  工作树,见 evidence.json `preexistingExternalFailures`。

## 8. 剩余缺口(下一切片)

1. 精度-召回联测(像素级 ground truth)标定逐实例 mip 定档与 1e-6 裕量;
   联测前 `DEEP_ENGINE_NATIVE_OCCLUSION_HIZ` 保持默认关(§7.1)。
2. 可见性缓冲两阶段管线。
3. 大预算层次化扫描(block_offsets 单线程扫在 1M 预算为常数量级,若未来放宽预算需
   升级为层次扫描;确定性纪律不变)。
4. 相机大幅前推的上一帧深度滞尾运动补偿(§6.4)。
