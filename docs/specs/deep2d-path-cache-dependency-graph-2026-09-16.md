# P1-02 第二批:全局依赖图 —— epoch / 相机维度(2026-09-16)

承接 [P1-02 第一批失效记账](deep2d-remaining-tasks-2026-09-16.md) 与删除检测子切片。第一批只做了
「同一帧内条目级失效原因记账」(结构→clip→resource→style),本批把**帧级依赖维度**并入依赖图:
内容来源 epoch 与相机物理缩放,并顺带修掉接线过程中暴露的一个真实缺陷。

## 依赖图口径(与 P1-01 ChartEpoch 对齐)

每条缓存条目携带 `EntryWitness{camera_scale_bits, resource_epoch}`。见证只影响失效判定与归因,
不参与几何产物——见证一致时细分结果逐字节可复用。

| 维度 | 对应 | 是否进依赖图 | 理由 |
| --- | --- | --- | --- |
| 相机物理缩放 | `set_camera_scale` / `display_list.scaleFactor` | **是** | 直接决定描边容差与曲线细分密度 |
| 内容来源 epoch | `set_resource_epoch`(换包/换源/resource_set) | **是** | 整批条目换代,资源集不再同源 |
| 单 path 资源内容 | `resource.id + verbs` | 是(第一批已有) | 细分输入变化 |
| clip 集合/矩形 | `clip_path_ids` / `clip_rect` | 是(第一批已有) | 裁剪几何与命令绑定 |
| 数据 revision | `display_list.revision` | **否(刻意)** | 改数据不改细分几何,进图只制造假失效 |
| z 序 / hitId | `z_order` / `hit_id` | **否(刻意)** | 纯呈现元数据,由当前帧元数据覆盖 |

`camera_scale_bits` 存 f64 位模式而非 f64:见证只做同一性比较,位比较同时消除
`-0.0/0.0` 与 NaN 载荷造成的「数值相等而见证不等」歧义。非有限缩放不写入见证,
退化为「无相机判定」而不是伪造失效。

## 归因顺序(固定,注释化在 prepare 内)

`相机 → epoch → 结构 → clip → resource → 风格`,LRU 逐出优先于一切(id 不在表中时
只能靠逐出记忆区分「刚被淘汰」与「首次出现」)。帧级维度先判定,因为它们解释
「为什么整批条目一起失效」,比条目级差异更接近根因。一次 miss 只记首个命中的维度,不双计。

## 接线过程中修掉的真实缺陷(本批最重要产出)

最初实现让**见证**取显式相机值,却仍把 `display_list.scale_factor` 传给细分函数。后果:

- 见证被盖成 `2.0`,几何却按 `1.0` 细分 → 条目自相矛盾;
- 此后**每一帧都会命中这个错误几何**(见证一致 → 视为命中),且失效原因被记为
  `camera_changed`,把「算错了」伪装成「换代了」;
- 实测形态:显式 `set_camera_scale(2.0)` 产出 387 顶点,而等价的 `scale_factor = 2.0`
  静态帧产出 591 顶点。

修复:抽出 `CameraWitness{scale_bits, scale}`,**见证与实际细分缩放同源产出**(`camera_witness`
一次取样),`prepare` 用 `camera.scale` 调 `prepare_path`。修复后两者逐值一致(591 = 591)。

这是本批唯一的行为修正,已由 `explicit_camera_declaration_drives_both_witness_and_tessellation`
锁定;该测试若被改回旧写法会立刻失败。

## 验证

新增 7 项测试(`src/deep2d/painter_cache.rs` 单元层,共 10 项):

| 测试 | 锁定的合同 |
| --- | --- |
| `explicit_camera_declaration_drives_both_witness_and_tessellation` | 显式相机同时决定见证与细分(缺陷回归锁) |
| `camera_scale_dependency_invalidates_once_and_rebuilds_exact_geometry` | 缩放变化整批按 `camera_changed` 失效一次;往返 1.0↔2.0 无漂移 |
| `resource_epoch_dependency_is_recorded_and_idempotent` | 换代记 `epoch_changed`;同代重复声明是空操作 |
| `data_revision_and_presentation_metadata_stay_out_of_the_dependency_graph` | 改数据/z 序/hitId **不得**触发重细分,且命中产物仍逐值正确 |
| `frame_level_dimensions_attribute_only_the_first_change` | 相机与 epoch 同时变只归因相机,不双计 |
| `unset_camera_witness_falls_back_to_display_list_scale` | 未声明相机时退回静态字段;NaN 见证不制造失效 |
| `structural_change_outranks_epoch_for_absent_entries` | 计数为累积口径:首帧首次出现 + 本帧新增;换代失效是一次性的 |

回归:既有 `deep2d_path_cache` 6 项、`deep2d_path_cache_invalidation` 11 项全绿(后者
1 项断言按新增字段同步,已在下方披露)。

## 公开合同变化(明示)

`Deep2dPathCacheMissReasons` 新增 `camera_changed` / `epoch_changed` 两个字段,
`Display` 与 serde JSON **字段序随结构体顺序前移**。消费方按字段名读取不受影响;
`deep2d_path_cache_invalidation::stats_display_and_json_summarize_miss_reasons` 的
字符串形状断言已同步到新形状并新增「Display 必须同时暴露新增维度」检查。
`Deep2dPathCache::set_resource_epoch` / `set_camera_scale` 为新增公开入口。

## 未覆盖(诚实条款)

- 宿主侧仍未接线:`deep2d_gpu.rs::stage` 未调用 `set_resource_epoch`/`set_camera_scale`,
  因此运行时行为与第一批等价(默认 `None`)。接线需要宿主把 ChartEpoch 与真实 DPI 传进来,
  属 P0 发布链路/宿主组装切片,不在本批。
- 相机维度当前承载 DPI/缩放;真正的三维相机(视图矩阵)不参与二维容器细分,不在此图范围。
- 本批未跑真实 GPU 窗口(纯 CPU 判定与既有测试面);未做浏览器交互遍历与双主题视觉闭环。