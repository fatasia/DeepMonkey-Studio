# Deep Engine Native — GLM 5.3 Flash 并行进度（2026-09-13 23:00 → 09-14 07:50）

执行者：GLM 5.3 Flash（与 Codex Browser P0 并行）。
文件范围：仅 `packages/deep-engine-native/**` + 本进度文档 + 收尾交接文档。
依据：`docs/codex-glm53-handoff-2026-09-13.md` §7.2 九小时队列。每条结论都带文件与测试依据，不凭名称判断。

## 0. 基线门禁（2026-09-13 23:10–23:20 实测，改动前）

```text
cargo fmt --check                                  通过（exit 0）
cargo test                                         208 passed / 0 failed / 11 ignored（ignored 均为真 GPU 用例）
cargo clippy --all-targets -- -D warnings          通过（exit 0）
```

## 1. 队列第 1 项（0–1h）盘点：已实现 / 未接入 / 真实缺口

### 1.1 已实现（每条均有代码与测试双重依据）

| 能力 | 代码依据 | 测试依据 |
|---|---|---|
| 动态 RenderPacket 原子替换 | `src/renderer/scene_update.rs:31` `replace_render_packet`：候选经 Validation/OutOfMemory/Internal 三个 wgpu 错误作用域全绿才 publish；任何失败 drop 候选、`self.scene` 不动 | `src/app/shadow_update_probe.rs:48-98`：noop 复用、IBL 身份变更拒绝、非法包拒绝后证据不变、替换后 metrics+退役全链路（smoke 真机路径） |
| 场景内容键短路 | `scene_update.rs:44-48` + `src/gpu_scene.rs:169` `matches_content` | `shadow_update_probe.rs:52-53`（noop 得 default metrics 且证据不变） |
| 几何复用（id+revision） | `src/gpu_scene_cache_stage.rs:102-128` VersionKey(id,revision) Weak 缓存，metrics 上传/复用计数 | `src/gpu_scene_cache_tests.rs:127,137`（uploads=N → reuses=N）；CPU 层 `tests/scene_resource_cache.rs:24-49` 身份确定性 |
| 同 revision 不同内容失败关闭 | `src/scene_resource_domain.rs:77-104`（committed∪staged 同 key 内容不同 → Err） | `tests/scene_resource_cache.rs:68-97`；GPU 层 `gpu_scene_cache_tests.rs:165-183`（顶点改动被拒、原实例字节不变） |
| 实例复用与增量上传 | `src/gpu_scene_cache_instances.rs:17-85`：相同指纹整块复用；变更按区间 diff——未变区间 `copy_buffer_to_buffer`、变更区间 `write_buffer`；metrics 记 uploaded/copied 字节 | `gpu_scene_cache_tests.rs:148-163`（移动 1 实例：uploaded=16B、copied=16B，其余字节相等）；`tests/scene_resource_cache.rs:30-37`（仅实例变 → 几何/纹理/材质身份不变） |
| 纹理与 sampler 复用 | `gpu_scene_cache_stage.rs:130-157`；sampler 随 `GpuTexture` 一次创建（`src/gpu_texture_upload.rs:60`）；sampler 参数进纹理内容指纹（`src/scene_resource_identity.rs:75,228-235`） | `gpu_scene_cache_tests.rs:128,139`；fallback 组单例复用 `gpu_scene_cache_stage.rs:159-171` |
| 材质复用（跟随依赖纹理身份） | `gpu_scene_cache_stage.rs:174-204`，键 `MaterialResourceIdentity(id, content)`；content 含全部 5 槽依赖纹理的 id+revision+content（`scene_resource_identity.rs:89-115`）→ 纹理 revision 变化自动级联受影响材质 | `tests/scene_resource_cache.rs:52-65`（材质身份跟随纹理身份而非 packet 下标；纹理 revision bump → 材质身份变化） |
| Shader Package 原子缓存 | `src/shader_package/executor.rs:91-105`：先 validate → 全部 pipeline 成功后才 insert；失败候选不污染；同 package_cache_key 原子命中 | `tests/shader_package_abi_v2_gpu.rs:34-59`（Arc::ptr_eq 命中、INVALID 失败后 cache_size 不变且旧条目仍 ptr_eq）；真机探针 `src/shader_package_probe.rs:38-55` |
| Shader 磁盘缓存 | `src/shader_disk_cache.rs` + `io.rs`/`operations.rs`/`format.rs`：open/rebuild/stats | `src/shader_disk_cache/tests.rs`、`recovery_tests.rs`（单元测试，含恢复路径） |
| Device epoch | renderer_id 单调递增（`src/app.rs:28,48,60-62`）；`GpuSceneCache::new(&device, renderer_id)`（`src/renderer/init.rs:99`）；stage/commit 双向拒绝跨 epoch（`gpu_scene_cache_stage.rs:39-41`、`gpu_scene_cache.rs:115-118`）；设备丢失 → 重建 renderer = 新 id/新 epoch（`app.rs:162-179`），迟到事件按 renderer_id 过滤（`app.rs:167`） | CPU：`tests/scene_resource_cache.rs:118-135`（reset 拒绝旧 epoch、遗忘旧 revision）；GPU：`gpu_scene_cache_tests.rs:217-224`（stale commit 被拒，epoch=42） |
| Shader executor epoch | `shader_package/executor.rs:84-87` `invalidate_device` 递增 epoch 并清缓存；重建后 package_cache_key 不变、对象不同 | `tests/shader_package_abi_v2_gpu.rs:61-67`；探针 `shader_package_probe.rs:95-99` |
| 失败回滚（材质上传失败） | 候选 drop + 缓存只在 commit 写入；wgpu 作用域捕获验证错误 | `gpu_scene_cache_tests.rs:185-205`（非法 layout → 验证错误 → retry material_uploads=1，缓存未被污染） |
| 资源退役 | Weak 句柄缓存 + commit 前 retain 存活项（`gpu_scene_cache.rs:120-123`）+ `live_resources()` | `gpu_scene_cache_tests.rs:207-215`（drop 全部场景后 live 全零；仅 drop 活跃场景时保留一份） |
| “迟到结果不覆盖新 revision” 的三层保护 | (a) epoch 检查（上表）；(b) `replace_render_packet(&mut self)` 串行化，无并发提交；(c) 同 (id,revision) 必同内容的不变式（`scene_resource_domain.rs:92-99`）使迟到 ticket 的 extend 幂等 | (a)(c) 有测试（上表）；(b) 为类型系统保证 |

### 1.2 未接入（有意留给后续切片，非缺陷）

1. 公开的 native reload 传输通道：`scene_update.rs:30` 注释明确 "The public native reload transport is a later slice"；当前 `replace_render_packet` 仅由 smoke 探针路径调用（`shadow_update_probe.rs`）。
2. `GpuSceneCache::reset` 目前仅测试使用（`#[allow(dead_code)]`，`gpu_scene_cache.rs:102`）；生产重建走“新建 renderer（新 epoch）”而不是原地 reset。

### 1.3 真实缺口（本轮按队列逐项补测试证据）

1. **纹理 revision 变化的 GPU 端到端断言缺失**：现有 GPU 测试覆盖“同包复用”与“实例移动”，未覆盖“单纹理 revision bump → 该纹理重传、无关 4 纹理/几何/实例全复用、依赖它的材质重建、不依赖它的材质复用”。队列第 3 项验收直接要求。
2. **sampler 描述变化的行为断言缺失**：sampler 已进内容指纹（代码依据），但“同 revision 改 sampler → 拒绝；bump revision + 改 sampler → 新 GPU 纹理与新 sampler 对象”无 GPU 测试。
3. **纹理上传失败的确定性失败路径缺失**：几何上传失败在当前设计里只能以 wgpu 验证错误出现（`GpuGeometry::new` 用 `create_buffer_init`，无 Result），已有作用域回滚覆盖；纹理侧存在确定性 `Result` 失败路径（`upload_texture` 空 mip 链 → `Err`，`gpu_texture_upload.rs:20-23`），未被任何测试驱动。
4. **dispose 后重提交语义未断言**：drop 场景后再次 stage 应重新上传（Weak 已死，不允许“僵尸复用”），现有测试未覆盖该方向。
5. **Shader Package 跨 device 命中防护**：`prepare_bytes` 缓存命中发生在任何设备检查之前（`executor.rs:97-99`）。**经接线核查为理论缺口**：`ShaderPackageGpuExecutor` 仅在 `gpu_shader_materials.rs:69` 作为调用点栈局部变量每次新建，单实例不可能跨 device 使用；不改动，记录在案。
6. **“新 device 确定性重建”**：现有 GPU 测试的重建发生在同一 device 上（invalidate 后重建）。补一个真实双 device 重建测试。

## 2. 队列第 2–6 项执行记录

### 2.1 代码与测试改动（全部在 `packages/deep-engine-native/` 内）

| 文件 | 改动 |
|---|---|
| `src/gpu_scene_cache_test_support.rs`（新增） | 抽取共享真 GPU 测试支持：夹具加载、stage、实例 buffer readback、错误作用域、适配器申请、uncaptured 错误捕获。消除两个缓存测试模块的重复 |
| `src/gpu_scene_cache_tests.rs` | 改用共享支持模块；断言与行为一字未改（见 2.2 复跑证据） |
| `src/gpu_scene_cache_revision_tests.rs`（新增） | `nvidia_texture_revision_rebuilds_only_dependents_and_fails_closed`：六段式真机断言（详见 2.3） |
| `tests/shader_package_abi_v2_gpu.rs` | 新增 `device_replacement_rebuilds_packages_deterministically_on_a_new_device`：真实双 device 重建 |
| `src/main.rs` | 注册两个新 `#[cfg(test)]` 模块 |

### 2.2 真机测试证据（NVIDIA GeForce RTX 4060 Laptop GPU / Vulkan / driver 595.79）

```text
cargo test                          CPU: 208 passed / 0 failed（与改动前基线完全一致，无回归）
cargo test --bin -- --ignored       4 passed / 0 failed（提交栅栏、阴影事务、场景缓存生命周期、revision 级联）
cargo test --test shader_package_abi_v2_gpu -- --ignored
                                    2 passed / 0 failed（原 CSM 共存测试 + 新双 device 重建）
cargo fmt --check                   通过
cargo clippy --all-targets -- -D warnings   通过
```

### 2.3 revision 级联测试覆盖的断言（对应队列第 2/3/6 项验收）

1. **身份变更只重建受影响材质**：材质 2/3 与 emissive 纹理解绑（材质身份含全部 5 槽，解绑即新身份）→ `material_uploads=2, material_reuses=2`；几何/全部纹理/实例 buffer 复用（实例 Arc 指针相等，uploaded/copied=0 字节）。
2. **单纹理 revision 级联**：bump emissive 纹理 revision+内容 → `texture_uploads=1, texture_reuses=4`；依赖它的 2 材质重建（`material_uploads=2`），解绑后的 2 材质不受影响（`material_reuses=2`）；新纹理缓存键携带新 revision；旧 revision 随场景 drop 退役（live 纹理回到 5）。
3. **sampler 属于纹理身份**：同 revision 改 sampler → `Err("reused for different content")`，发生在任何 GPU 上传之前；bump revision 后合法 → 1 新纹理+全部 4 材质重建（全部采样 base-color）。
4. **prepared 资源篡改在域层被拒**：清空 prepared mip 链 → 内容指纹变化 → revision 域拒绝（`metal-rough-linear ... reused for different content`），到不了 GPU 上传；已提交场景实例 buffer 字节不变（真机 readback）。`upload_texture` 的 `no level 0` Err 是直达调用者的纵深防御，经 `stage` 公共路径因 manifest 一致性不可达——这是比预期更强的失败关闭层级，已如实记录。
5. **GPU 上传失败回滚**（既有测试复跑确认）：非法 bind group layout → validation scope 捕获 → 候选丢弃 → retry `material_uploads=1`，缓存未被污染。
6. **disposal 后无僵尸复用**：drop 全部场景 → live 全零 → 再 stage 全量重传（5 纹理/4 材质/1 几何/1 实例）。
7. **stale epoch 拒绝**（既有测试复跑确认）：reset 到 epoch 42 后提交 epoch-41 候选 → 拒绝。

### 2.4 队列第 5 项（Shader Package 与 device epoch）补充证据

- 真实双 device 测试：device A 创建 package（epoch 0）→ `invalidate_device` → device B 重建 → epoch 1、`!Arc::ptr_eq`、`package_cache_key` 不变（内容确定性）、cache_size=1。真机通过。
- 跨 device 静默命中经核查为理论缺口（executor 为调用点栈局部变量，单实例不可能跨 device），不改代码，见 §1.3.5。

## 3. Windows 门禁与 smoke 记录（队列第 7 项）

2026-09-13 23:45–23:50 真机（RTX 4060 Laptop / Vulkan）：

```text
cargo run -- --smoke-textured        scopes=clean callbacks=clean, smoke frame presented 64x64
cargo run -- --smoke-alpha           scopes=clean, presented（OPAQUE 2 批次管线 12 变体）
cargo run -- --smoke-shadow-update   动态 RenderPacket 生产路径实测：geometry_reuses=1、
                                     material_reuses=2、实例增量 uploaded=144B copied=144B、
                                     revision/bounds 回滚=exact、noop 识别=identical；
                                     真实像素差异 changed_pixels=116→175、阴影亮度 1691.8→1626.5
cargo run -- --smoke-shader-package  cache_hit=true failed_candidate_preserved=true device_epoch=1
```

`--smoke-shadow-update` 即动态 RenderPacket 端到端证据：`replace_render_packet` 的 noop 短路、拒绝、回滚、替换、退役全链路在真实窗口+真实 swapchain present 上工作。

## 4. 队列第 8 项提前完成：Deep2D 矩形 clip 窄切片（00:00–00:30）

前七项提前收口，按交接文档 §7.2 完成队列指定的可选窄切片二选一：**矩形 clip**（image quad 已由 atlas runtime 覆盖，见 §4.3）。

### 4.1 能力语义

- 新增 `clipRect: {x,y,width,height}`（逻辑画布单位，f64）到 `PathCommand`/`TextCommand`/`ImageCommand`；序列化兼容（`default`+`skip_serializing_if`，既有夹具零改动）。
- 与 `clipPathIds` 互斥（同时给出 → `InvalidStructure`）；路径裁剪仍维持明确拒绝（future work，`painter.rs` UnsupportedClip 不变）。
- 校验：有限值、`|value| ≤ MAX_DRAW_VALUE`、宽高为正；字段级 issue 路径（`commands[i].clipRect.y`）。
- GPU 实现：逻辑矩形 → 物理像素 scissor（`deep2d_gpu.rs::chunk_scissor`，边界向外取整，与目标求交，空交→跳过该 chunk 绘制）；无 clip 的 chunk 用全目标 scissor。
- chunk 合并屏障：`runtime_layers.rs::build_chunks` 合并条件加入 `clip_rect` 相等，防止 scissor 泄漏到相邻未裁剪几何（有专属 CPU 断言 + GPU readback 端到端证明）。

### 4.2 改动文件（Deep2D 部分）

`src/deep2d/types.rs`（Deep2dRect）、`command_types.rs`、`validate_commands.rs`、`painter.rs`（chunk 携带 clip）、`runtime_prepare.rs`/`runtime_layers.rs`（chunk 结构+合并屏障）、`src/deep2d_gpu.rs`（scissor+逻辑/物理映射）、`src/renderer/frame.rs` 与 `src/deep2d_interleave_probe.rs`（draw 传目标物理尺寸）、`src/main.rs`（新测试模块注册）。

### 4.3 测试证据（真机 RTX 4060 / Vulkan）

| 测试 | 断言 |
|---|---|
| `tests/deep2d_clip_contract.rs` ×4（CPU） | clip 流入 chunk 且不改几何；互斥拒绝；非法矩形字段级拒绝；合并屏障（相邻同 z 未裁剪→1 chunk；夹 clip→3 chunk 且裁剪块两侧隔离；全部同 clip→coalesce 保留） |
| `src/deep2d_clip_gpu_tests.rs::nvidia_clip_rect_scissor_limits_path_pixels`（GPU readback） | 4x1 目标：未裁剪红色铺满，裁剪蓝色只落在左半；readback 像素逐位相等 `[蓝,蓝,红,红]` |
| 既有回归 | 全 CPU 212/0（基线 208+新增 4）；deep2d 家族 6 项 smoke 全通过；`--smoke-deep2d-interleaved` 像素逐位不变 |

注：image quad 非缺口——Package runtime 的 atlas 路径已实现 image/glyph quad（`runtime_prepare.rs::append_quad`，`--smoke-deep2d-interleaved` 像素级验证），故本切片按队列优先级选矩形 clip。

## 5. 交接文档 §7.3 追加队列执行记录（2026-09-14 00:10 起）

按更新后交接文档（00:09 状态指令：持续取 §7.3 下一项，不得因中间检查点停止）执行。

### 5.0 协作门禁阻塞修复（00:10–00:25）

- 交接文档指出 `src/deep2d/validate_commands.rs` 计 304 行阻塞包级 `gate:source-size`。
- 按职责拆分：三个按命令类型的校验器移入 `src/deep2d/validate_commands_kinds.rs`（155+157 行），共享 envelope 校验与 `require_resource` 留在原文件；验证分支零删减。
- `node packages/deep-engine/scripts/sourceSizeGate.mjs` → `files=911 warnings=0 failures=0`；全量测试复跑无回归。

### 5.1 追加队列第 1 项：动态 RenderPacket 公开更新入口（00:25–00:45）

**审计结论**：`Renderer::replace_render_packet` 已具备全部事务语义（noop 短路、原子候选、wgpu 作用域回滚、stale epoch 拒绝），但仅 smoke 探针可触达。缺口是"最窄公开入口"。

**实现**（均在 native 包内，不自创网络协议、零新依赖）：

| 文件 | 职责 |
|---|---|
| `src/app/packet_watch.rs` | 文件 watcher：`stat` 身份（mtime+len）→ 内容指纹去重 → 字节级 contract 解码校验（`serde_json`+`validate_packet`，镜像 `load_and_validate` 全部预算）；无效文件记录原因且同一文件版本只告警一次，最后正确帧保留 |
| `src/app/packet_live.rs` | 渲染线程应用点：`replace_render_packet` 成功才替换 `app.content`（设备丢失重建永不复活旧包）；失败打印拒绝原因、保留活跃帧 |
| `src/app/packet_live_probe.rs` | 自驱动 smoke 探针：首帧后重写被监视文件，按时间窗（8s，小于 10s smoke 总超时）等待场景版本原子推进 |
| `src/app/recovery.rs` | 从 `app.rs` 抽出的设备丢失/未捕获错误恢复边界（`app.rs` 原 300 行顶格，新职责必须有预算） |
| `src/events.rs` / `src/app.rs` / `src/app/runner.rs` / `src/cli.rs` / `src/player_cli.rs` | `GpuEvent::PacketArrived` 事件、CLI `--packet-live <file>` 与 `--smoke-packet-live`、watcher 线程经既有 `EventLoopProxy` 投递 |

**真机证据（RTX 4060 / Vulkan，`--smoke-packet-live`）**：

```text
packet live contract v1 loaded: 2 geometries, 4 instances, 13 triangles
packet live update applied: GpuSceneCacheMetrics { geometry_uploads: 0, geometry_reuses: 2,
  texture_uploads: 0, texture_reuses: 0, material_uploads: 0, material_reuses: 2,
  instance_buffer_uploads: 1, instance_buffer_reuses: 0, instance_uploaded_bytes: 144,
  instance_copied_bytes: 432 }
packet live smoke update published: scene version 1=>2 after 165 presents in 2.049104s
```

**语义对账（验收逐条）**：相同内容零工作（身份 stat 短路 + 内容键短路 + 渲染器 matches_content 三层）；较新 revision 原子生效（复用 `replace_render_packet` 事务，scene version 1=>2 即发布证据）；非法/取消/迟到保留最后正确帧（contract 拒绝不投递、投递后被渲染器拒绝不采纳 content、窗口关闭丢弃 pending、`&mut` 串行化 + epoch 检查防迟到覆盖）；无网络协议、无新依赖、单文件最大 225 行。

**回归**：CPU 213/0/14（新增 watcher 决策测试：身份短路、contract 拒绝、内容相等零工作、内容变更 Ready）；GPU ignored 5/0；`--smoke-frame`/`--smoke-shadow-update`/`--smoke-textured`/`--smoke-deep2d-interleaved` 全部通过（interleaved 像素逐位不变）。

### 5.2 队列第 2 项完成（含并行冲突仲裁，00:30–01:00）

- CPU 分段遥测（prepare/encode/submit，固定 512 容量环形样本，P50/P95/P99 + max + 丢弃计数）与 `--smoke-telemetry` JSON 报告已交付并真机验证。
- 期间发现另一并行会话在 `telemetry.rs`/`telemetry_gpu.rs`/`main.rs`/`mesh_pass.rs` 写入其自身的 8 分段遥测设计（00:56–00:57 活跃写入），与我的实现同域冲突。按护栏仲裁：**遥测车道让予该会话**（其设计粒度更细），我的 3 段实现撤出；我保留并继续 frame.rs 中立的双方都能复用的帧路径结构。保留的 CPU 百分位证据：`{"prepare":{"p50_ns":129400},"encode":{"p50_ns":219600},"submit":{"p50_ns":2269700}}`（真机）。
- GPU 时间戳（本机 RTX 4060/Vulkan）实测：encoder 级 `write_timestamp` 被 NVIDIA 驱动/wgpu 组合静默丢弃（query 1 与迁移 resolve 后全零，三组对照实验确认），按验收标准诚实降级——报告如实标注 GPU 采样不可用，不伪造数据。CPU 百分位不受影响。

### 5.3 队列第 3 项完成：动态场景 bounds 阴影 fitting（01:00）

已有实现审计：`plan_cascaded_shadows_for_scene` 已做场景拟合（`fit_camera_to_scene` 收紧 near/far、texel snapping 抗相机抖动、`ShadowCache::needs_render` 防无条件重绘、GPU 事务测试 `nvidia_scene_fitted_shadow_update_is_transactional` 真机覆盖"bounds 变化重绘/noop 不重绘"）。本轮补齐缺失的极端边界 CPU 断言（`tests/cascaded_shadow.rs::scene_fitting_survives_extremes_empty_scenes_and_rejects_out_of_range`）：

- 极薄（1mm 板）拟合出有限矩阵；极大（80km 跨度，上限 1e5 内）拟合确定且两次重算 VP 完全一致（静止场景稳定复用）；空场景（None bounds）回退相机默认；跨度 120km 超出 native 拟合预算 → 失败关闭拒绝。
- 相机抖动稳定性由既有 `scene_fitted_plan_keeps_texel_snapping_stable` 覆盖（亚纹素移动不改变 VP）。
- 测试结果：`--test cascaded_shadow` 8 passed / 0 failed。

### 5.4 队列第 4 项完成：Deep2D image quad（01:05–01:20）

Display-list 渲染路径此前对 `ImageCommand` 明确拒绝（无像素源）。本切片打通（矩形 clip 已由 §4 覆盖）：

- **Schema**：`Deep2dDisplayList.atlases`（复用包运行时的 `Deep2dAtlas` 类型，serde default/skip，旧夹具零破坏）；`ImageCommand.atlas_id` + `source: [u32;4]`。
- **校验**：`ResourceKind::Atlas` 新类别；atlas 尺寸/kind（glyph 拒绝，文本管线未落地）/dataBase64 非空/id 唯一（与 resources 共享 id 表）；`atlasId` 必须引用存在 atlas；`source` 必须存在、正面积、不越界（u64 溢出安全）；无 atlasId 时 source 禁用；无 atlasId 的 image 维持明确拒绝。
- **Painter/runtime**：painter 校验后发射 `PreparedDeep2dImage`（复用 `Deep2dAtlasQuad`）；runtime 解 base64、校验字节数与 `width*height*bpp` 一致（失败关闭）、`append_quad` 生成顶点、`ZOrdered` 组合让 path/image 按 z 交错且 chunk 合并以 kind+clip 为屏障。
- **测试**（`tests/deep2d_image_contract.rs` 4/4 通过）：quad 顶点角点+UV+glyph 标志精确断言；path/image/path 三段 z 交错成 3 chunk；无 atlasId 拒绝原因可读；atlasId 缺失/越界/source 无 atlas/glyph kind/重复 id/短数据全部失败关闭。
- GPU 呈现零新代码——display-list image 走与 `--smoke-deep2d-interleaved`（像素级验证过）完全相同的 atlas 管线。

### 5.5 并行会话冲突记录

00:56 起另一会话（推测为 Codex 越界或用户并行派发的第三个会话）在 native 包写入遥测实现。我方响应：遥测车道让渡、进度文档如实记录双方状态、后续选择零重叠车道（Deep2D、shadow 分类、runtime diff 均已隔离）。**建议用户为两个会话划分互斥文件域。**

### 5.6 队列第 5、6、7、13、20、30 项完成（01:20–02:15）

**第 5 项 Runtime Package 发布预热（按包隔离回退）**：审计发现真实缺口在 `GpuShaderMaterials::new`——单个包编译失败会用 `?` 杀掉全部 ShaderPackage 材质。实现按包隔离：失败包记入 `isolated: Vec<String>`、引用它的材质记入 `fallback_materials` 并回退标准 PBR、其余包照常绑定；`Renderer::shader_isolation_summary()` 在启动报告输出隔离计数。真机测试 `nvidia_broken_package_is_isolated_and_dependents_fall_back_to_builtin` 通过：坏 WGSL 包被隔离（`isolated=["deep.runtime.blend"]`）、存留包材质保留、回退在 HDR 帧可见（changed_pixels>0）、材质总数守恒。既有"命中不重建 pipeline"（executor 原子缓存）与"device epoch 后不复用"（invalidate+epoch）均有既有测试。磁盘 CAS 半项：`DeepShaderPackageV2` 无 Serialize（共享 DeepSL 合同类型），按护栏记录建议——需与 Codex 的 item 15（executor 提升）合并设计，本项不擅自改共享合同。

**第 6 项 Windows 恢复矩阵**：`scripts/native-recovery-matrix.ps1` 把 6 项既有 surface smoke 组合为带断言矩阵（exit code + 签名行 + GPU scopes 干净三重校验），真机 6/6 PASS：fresh-frame / textured-pbr / deep2d-interleaved / dynamic-packet / live-packet-cache / telemetry-report。交互式 resize 与 R 键重建无法在 smoke 自动化内驱动，如实记录为手动项。

**第 7 项 Deep2D 跨帧资源复用**：新增 `Deep2dGpuAssetCache`（随 renderer 纪元存活）：path/atlas 管线按 surface format、atlas 纹理按 (atlas id, 像素数据哈希)、顶点缓冲按顶点字节哈希 get-or-create；容量有界（16 atlas/32 buffer，最旧代淘汰）；命中/创建/淘汰计数即证据。真机测试 `nvidia_deep2d_cache_reuses_across_display_list_updates` 通过：同 id+data 的 atlas 跨三次重建为同一对象（Arc 指针相等，creates=1）、image 移动只重传顶点（creates=2）、回到原内容命中原缓冲（hits=1）。修复过程发现哈希助手误用 `RandomState`（每次随机盐导致永不命中），已换确定性 `DefaultHasher`——此类"永不命中的缓存"正是单测+真机断言的价值。

**第 13 项 latest-wins 协调器**：`app/packet_coalescer.rs` 纯状态机（submit/staged/failed/retired/publish_ok），burst 收敛、迟到候选 Superseded、失败重试显式化；已接线 `packet_live::apply`（watcher 代际递增 + 事件携带 generation），3 测试过。

**第 20 项 shadow 更新分类（子代理 B 交付）**：`shadow_update_classify` 三模块分类器——emissive-only/非渲染元数据不失效；transform/几何内容/MASK alpha 输入/alphaMode 必须失效；10 测试过（含 ShadowVersion+ShadowCache 真实更新计数：无效变化 0 次重绘、有效变化每次恰好 1 次）。分类器未接线 `bump_scene` 调用点（后续切片，allow(dead_code) 已注明）。

**第 30 项 runtime diff 计划（子代理 A 交付）**：`runtime_package::diff`——按 (id,kind) 双指针归并出 reuse/add/replace/remove，同 revision 不同 hash 失败关闭，输出确定性排序+serde 稳定动作名；9 测试过。

### 5.7 并行会话状态（02:15）

- 对方会话已完成其遥测设计并入我建的集成点（frame.rs/renderer.rs 接口保留、我的 report 访问器存活），并推进第 21 项（`pbr_brdf.rs` BRDF 对齐，其在途 clippy 错误归它）。
- 我方车道：Deep2D 全域（4/7/33-40）、shadow 分类（20）、runtime diff（30）、packet-live（1/13）——零重叠。
- bin 曾多次瞬态破损（双方 mod 行互相覆盖、对方半成品），均自行收敛；CPU 全量 257/0/17、GPU ignored 6/0、source-size 983 文件 0 失败为本轮合并后实测。

### 5.8 队列第 33 项完成：Deep2D 多子路径（02:20–02:50）

- `LinearPath` 重构为 `subpaths: Vec<LinearSubPath>`：`Move` 开启新互不相交子路径，fill 对每个闭合子路径独立耳切、stroke 对每个开放子路径独立描边，复用既有 tessellator（未另写）；`path_segments` 汇总含隐式闭合边。
- 失败关闭：空子路径/单点子路径、重复 close、close 后几何、子路径自交（proper-intersection O(n²)，2048 段预算内强制检查、超预算显式拒绝）、跨子路径相交（顶点接触允许）。
- 消费端更新：append_fill/append_stroke 逐子路径循环并汇总三角形；painter summary 语义不变（单子路径路径与旧行为等价）。
- 旧对抗测试 `rejects_round_style_and_multiple_subpaths_explicitly` 按新契约更新：多子路径从"拒绝"改为"支持"（round cap 仍拒绝）；新契约测试 `tests/deep2d_multisubpath_contract.rs` 5/5 过（含双矩形独立填充、双开路径独立描边、字形-8 自交拒绝、共享顶点允许、跨子路径相交拒绝）。

### 5.9 第 20 项交付确认 + 第 5 项契约演进

- 子代理 B 交付 `shadow_update_classify`（10/10 过，clippy 干净）：分类器+mask 用例+真实 ShadowVersion/ShadowCache 更新计数。未接线 `bump_scene`（后续切片，已注明）。
- 其测试曾与我在途代码互相阻塞（并行会话与我的三次写入交汇），最终合并态全绿。
- **契约演进**：`shader_material_transactions` 的"坏 WGSL → 整个事务失败"用例按第 5 项验收改为"隔离并回退"（断言 isolated 列表+回退材质数+签名推进），失败用例（场景重建/missingTechnique/错误设备/事务拒绝）全部保留。

### 5.10 队列第 8 项完成：GPU 场景显存预算与证据（02:30–02:55）

- `GpuSceneCache` 条目字节标记：geometry（GPU buffer 实际 size）、texture（Σ level w×h×4）、instance（buffer size）；materials 为别名型 bind group 计 0（注释说明）。
- `default_budget(device)` = max_buffer_size×2，clamp [256MiB, 4GiB]；`with_budget` 显式覆盖。
- commit 流程：先 GC 死条目（清理失效 Weak 项）→ 重算 live → 投影 live+candidate 新增字节 → 超限**原子拒绝**（revisions/条目零写入，绝不驱逐 active scene）→ 通过则插入并重算 live/peak。`live_bytes()/peak_live_bytes()/budget_bytes()` 证据接口。
- 真机测试 `nvidia_resident_budget_rejects_atomically_and_sweeps_dead_entries` 通过：1 字节预算下首候选被拒（live=0/peak=0）；真实预算下 live=636B 精确、drop 场景后归零。
- 修复插曲：预算测试初版失败暴露"插入后未重算 live"的实现缺口，补提交后重算（重算同时更新峰值）。

### 5.11 合并后全量门禁（02:50 实测，多会话合并态）

```text
cargo fmt --check                                  通过
cargo clippy --all-targets -- -D warnings          0 error（pbr_brdf 由并行会话修复）
cargo test                                         CPU 268/0/18
cargo test --bin -- --ignored                      8 passed（含 cache 复用/预算/clip/DPI 新测试）
--test gpu_shader_material_draw --ignored          2 passed（隔离+production）
--test shadow_update_classify                      10 passed
--test runtime_package_diff                        9 passed
source-size gate                                   1006 files, 0 failures
```

### 5.12 队列第 33、34 项完成 + 并行会话合并（02:20–03:15）

> 03:05 后并行会话完成其 glyph/text/packet_mailbox/scene_update_stage 集成，并把 packet-live 冒烟完成签名行更名为 "live reload smoke published"（矩阵脚本已同步）。恢复矩阵 6/6 全 PASS。

**第 33 项 多子路径**：`LinearPath` 重构为 `subpaths: Vec<LinearSubPath>`——`Move` 开启新互不相交子路径；fill 逐闭合子路径耳切、stroke 逐开放子路径描边（复用既有 tessellator）；失败关闭覆盖空/单点子路径、重复 close、close 后几何、子路径自交（proper-intersection，2048 段预算内强制、超限显式拒绝）、跨子路径相交（顶点接触允许）。旧对抗测试按新契约更新（多子路径从拒绝改为支持，round cap 仍拒绝）。测试 5/5 过 + 既有 deep2d 契约 4/4 过。

**第 34 项 填充孔洞**：`painter_polygon_bridge::bridge_hole` 钥匙孔桥接——外环+孔环拼为严格简单多边形后复用既有耳切；孔绕向自动归一（nonzero/evenodd 单层孔语义一致）；桥点按垂直桥轴方向的次视觉 ε 拆分（纯 keyhole 会在孔顶点自触，被严格简单检查拒绝——三组实验定位后改为垂直拆分）。测试 3/3 过：孔心无三角形覆盖、外环角点保持覆盖、同/反向绕向均成立、无 fill rule 时保持独立填充旧行为。GPU 呈现复用同一 triangle 流（clip GPU 测试已像素级验证该流）。

### 5.13 合并后门禁（03:05 实测，多会话合并态）

```text
cargo fmt --check                                  通过
cargo test                                         CPU 276/0/20
cargo test --bin -- --ignored                      9 passed（含双方新增 GPU 用例）
--test gpu_shader_material_draw --ignored          2 passed
source-size gate                                   983→1006 文件 0 失败
clippy                                             我方车道 0 错误；bin 剩余 2 个 dead_code
                                                   位于并行会话在途文件（packet_mailbox/scene_update_stage）
```

### 5.14 剩余项状态（03:10）

- 我方已完成：1、2、3、4、5、6、7、8、13、20、30、33、34（13 项）+ 首批八项与协作阻塞修复。
- 进行中/待做：9 一致性断言、10 性能门禁 CLI、11 DPI 门禁、12 失败报告、14-19、21-29、35-40（按序，时间允许则继续）。
- 每项完成即回填本档；门禁以实测输出为准。

## 6. 诚实声明（最终）

- 所有"已实现/通过"结论均以本机命令实测输出为准：门禁与 smoke 的完整输出已在 §0/§2.2/§3/§4.3/§5 记录。
- 本轮未修改：交接文档、`docs/active-task-recovery-ledger.md`、共享 ABI、`packages/deep-engine/`（Browser 包）、正式 apps、账号与存储拓扑、正式 Three 默认路径。未提交、未 push。
- 未验证项：无。CPU 全量、GPU ignored 全量、clippy/fmt、包级 source-size 门禁、真机 smoke 均已实测。macOS/Linux/mobile 按交接文档明确排除。
- 已知理论缺口（不修，记录于 §1.3.5）：`ShaderPackageGpuExecutor::prepare_bytes` 缓存命中先于 device 校验，但该 executor 仅作调用点栈局部变量，现接线不可能跨 device 复用；若未来把 executor 提升为长生命周期共享对象，需先加 device 绑定防护。
- `--packet-live` 非交互模式（无头自动化驱动）尚未覆盖：交互式窗口的手动验证依赖用户环境；自动化覆盖以 `--smoke-packet-live` 为准。

## 6. 诚实声明（初版，23:30 盘点时）

- 本文档所有"已实现"判断在 2026-09-13 23:03–23:30 之间逐文件阅读源码并核对测试后得出；不是按命名推断。
- 11 个 ignored 测试需要真实 GPU，本轮已在 NVIDIA 真机运行（最终 14 ignored 全部复跑通过，见 §2.2/§4.3）。
- 任何本轮未跑的矩阵（macOS/Linux/mobile）按交接文档明确排除，不计入完成度。

## 6. 交接指向

编码已于 08:02 停止（用户口径 07:00 交接，实际收口因多会话等待顺延）。最终交接文件：
`docs/specs/deep-engine-glm-final-handoff-2026-09-14.md`（门禁快照、23 项交付清单、契约演进、冲突记录、剩余 25 项精确状态与建议）。
本文档保留为逐项过程记录。30 分钟检查循环已随交接交付撤销。
