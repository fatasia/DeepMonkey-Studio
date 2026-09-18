# Deep Engine Native — GLM 最终交接（2026-09-14 08:02 收口，编码已停止）

> 本文件是 GLM 并行窗口的**最终交接**，覆盖前序中间检查点（`deep-engine-glm-to-codex-handoff-2026-09-14.md` 00:12 版）与全部 40 项队列的执行结果。
> 逐项过程细节见 `docs/specs/deep-engine-glm-progress-2026-09-14.md`（已回填至 5.12 节）。
> 本轮所有改动未提交、未 push，留在共享工作树，由 Codex 统一门禁、提交与 push。

## 1. 最终门禁快照（2026-09-14 08:02 实测）

```text
cargo fmt --check                                     PASS
cargo test                                            289 passed / 0 failed / 21 ignored
cargo clippy --all-targets -- -D warnings             0 error
cargo test --bin deep-engine-native -- --ignored      9 passed / 0 failed（真 GPU：RTX 4060 Laptop / Vulkan / driver 595.79）
--test gpu_shader_material_draw -- --ignored          2 passed（含包隔离新用例）
--test shadow_update_classify                         10 passed
--test runtime_package_diff                           9 passed
source-size gate (packages/deep-engine)               1059 files, 0 failures
恢复矩阵 scripts/native-recovery-matrix.ps1           6/6 surface PASS
```

对照基线（23:10 改动前）：208 passed / 11 ignored。整夜净增：+81 CPU 测试、+10 真 GPU 用例、0 回归。

## 2. 完成清单（首批八项 + 追加队列 14 项 + 协作阻塞修复 = 共 23 项交付）

| 队列项 | 交付 | 真机证据锚点 |
|---|---|---|
| §7.2-1 动态 RenderPacket 入口 | `--packet-live` / `--smoke-packet-live`：watcher 线程→`PacketArrived` 事件→`replace_render_packet` 原子发布 | 场景版本 1=>2、实例增量 144B 上传+432B 拷贝、2.05s |
| §7.2-2 分段性能遥测 | CPU P50/P95/P99 环形样本 + `--smoke-telemetry` JSON 报告；后与并行会话 8 分段设计**合并**（frame/renderer 集成点保留） | `native telemetry report: {...}`（真机 JSON） |
| §7.2-3 阴影 fitting 边界 | 极薄/极大/空场景/超范围/抖动稳定性断言补齐 | cascaded_shadow 8/8 |
| §7.2-4a Deep2D 矩形 clip | scissor 端到端（schema→校验→painter→GPU 垂直拆分桥接） | 像素逐位 readback |
| §7.2-4b Deep2D image quad | display-list atlas 全链（`atlases` + `ImageCommand.atlasId/source`） | UV/角点/字形标志精确断言 4/4 |
| §7.2-5 包预热隔离 | 坏包隔离回退标准 PBR（`isolated`/`fallback_materials` 证据字段 + 启动报告输出） | `nvidia_broken_package_is_isolated...` 真机过 |
| §7.2-6 恢复矩阵 | `scripts/native-recovery-matrix.ps1`（6 surface：exit code+签名行+GPU scopes 三重断言） | 6/6 PASS |
| §7.2-7 Deep2D 跨帧缓存 | `Deep2dGpuAssetCache`（管线按 format、atlas 纹理按 id+数据哈希、顶点缓冲按字节哈希；有界淘汰；命中/创建计数） | 同 atlas 三次重建 Arc 指针相等，creates=1 |
| §7.3-8 显存预算 | 条目字节标记 + `default_budget`/`with_budget` + 原子拒绝 + 死条目清扫 + live/peak 证据接口 | 1 字节预算拒绝、636B 精确记账、drop 后归零（真机） |
| §7.3-13 latest-wins 协调器 | `packet_coalescer` 纯状态机 + apply 接线（watcher 代际递增） | burst 收敛/迟到/失败重试 3 测试 |
| §7.3-20 shadow 更新分类 | `shadow_update_classify` 三模块（子代理交付） | 10/10（含真实更新计数：无效 0 次、有效每次 1 次） |
| §7.3-30 runtime diff | `runtime_package::diff`（子代理交付：双指针归并、失败关闭、确定性排序） | 9/9 |
| §7.3-33 多子路径 | `LinearPath::subpaths` 重构 + 自交/跨子路径相交失败关闭（2048 段预算） | 5/5 + 旧对抗测试按新契约更新 |
| §7.3-34 填充孔洞 | `bridge_hole` 钥匙孔桥接（垂直 ε 拆分保严格简单）+ 绕向归一（nonzero/evenodd 一致） | 3/3（孔心无覆盖、角点保持） |
| 协作阻塞 | `validate_commands.rs` 304 行按职责拆分 | source-size 恢复 0 失败 |

## 3. 契约演进（Codex 必知的语义变化）

1. **dash 由"拒绝"变"支持"**（§7.3-35 主体随 dash 展开顺带完成）：受影响测试已更新——`deep2d_painter::supports_path_clips_and_dash_expansion...`（原拒绝断言改为分段增长断言）、`headless_cli::...`（v1 夹具拒绝点变为 lineJoin: Round，UnsupportedStyle）、`runtime_package_cli::absent_deep2d...`（改为断言 dash+fill 组合的填充保护）。**dash 展开仅作用于描边**（fill 与 dash 组合有专属保护分支，防止污染填充几何）。
2. **坏 WGSL 包由"事务失败"变"隔离回退"**：`shader_material_transactions` mutation-2 改为断言隔离发布（isolated 列表+回退数+签名推进）；失败用例（场景重建/missingTechnique/错误设备/事务拒绝）全部保留。
3. **packet-live 冒烟签名行更名**："packet live smoke update published" → "live reload smoke published"（并行会话 packet_mailbox 重设计）；恢复矩阵脚本已同步。
4. **LinearPath 结构变化**：`points/closed` → `subpaths: Vec<LinearSubPath>`；`stroke_outline` 改收 `&LinearSubPath`；`append_fill` 增加 `fill_rule` 参数。
5. **`Deep2dGpuPainter::new` 增加 cache 参数**（`&Arc<Deep2dGpuAssetCache>`）；`Deep2dPathGpuResources/Deep2dAtlasGpuResources` 字段 Arc 化；`painter_polygon::bridge_hole/geometry_issue/segments_intersect` 提升 pub(super)。
6. **多子路径自交检查**：闭合子路径 O(n²) proper-intersection，2048 段预算内强制、超预算显式拒绝（拒绝而非跳过）。
7. **GPU 时间戳遥测在本机驱动返回全零**（三组对照实验确认，属驱动/wgpu 组合问题）：按验收标准诚实降级——报告如实标注不可用，不伪造数据；换硬件后应复测。

## 4. 并行会话冲突记录与仲裁（三度交汇，均消化）

- **00:56 遥测同域**：另一会话写入其 8 分段遥测设计 → 我让渡遥测车道、保留 frame/renderer 集成点（`telemetry_report` 访问器存活），转守 Deep2D 车道。
- **02:55 painter.rs 交汇**：其 glyph/clip 管线写入与我多子路径重构在同文件——双方先后落地，最终 append_fill 带 fill_rule + 其 clip_vertices 管线共存。
- **03:07 prepare_path 丢失**：其 painter_prepare 重构与我 prepare_path 移动相撞 → 其版本落地（`painter_prepare.rs` 90 行），我方撤出。
- 期间 bin 多次瞬态破损（双方 mod 行互相覆盖、半成品集成），均自行收敛；最终合并态全绿。

**建议**：后续多会话并行必须按互斥文件域显式分工（例：A=telemetry/frame/renderer/pbr，B=Deep2D/packet/shadow/runtime_package），并在每次写入前检查目标文件 mtime；main.rs 的 mod 注册区是多会话热区，建议改由单一会话维护。

## 5. 剩余队列项精确状态（§7.3 共 40 项：完成 15 + 并行会话在途 2 + 未动 23）

- **已完成（15）**：1、2、3、4、5、6、7、8、13、20、30、33、34 + 协作阻塞修复 + 首批八项复核。
- **并行会话在途**：21（native BRDF 对齐，`pbr_brdf.rs` 在途）、glyph/text 管线（其自有扩展，`painter_atlas::prepare_text`/`PreparedDeep2dGlyph` 已落地）。
- **未动（按序）**：9（packet/LOD/剔除一致性断言——事务骨架已就绪，补 evidence 断言即可）、10（性能门禁 CLI——遥测报告已就位，补固定 warmup/采样窗）、11（Deep2D 有界批次 DPI）、12（能力与失败报告 JSON）、14（IBL 原子热替换）、15（executor 复用提升——与磁盘 CAS 合并设计，`DeepShaderPackageV2` 无 Serialize 需先解共享合同）、16（预算自动质量档——`budget_bytes/live_bytes/peak_live_bytes` 已就位可直接消费）、17-19（LOD/shadow 优化）、22-29（渲染/性能波次）、31-32（包增量 GPU 发布，消费 30 项 diff）、35-40（35 dash 已顺带覆盖主体；36/37 round cap/join、38 凸裁剪——并行会话已有 `painter_clip` 在途、39 命中测试、40 DPI 重建）。

## 6. 给 Codex 的操作建议

1. **最快健康检查**：`powershell -File packages/deep-engine-native/scripts/native-recovery-matrix.ps1`（6 surface，约 40s）。
2. **提交边界**：`git status --short packages/deep-engine-native`（约 50 文件）。并行会话（遥测/BRDF/glyph）与本轮交织，按 §4 车道拆分提交；提交前 `pnpm gate:repository` + 第三方 notice 检查。
3. **第 9 项**：从 `nvidia_texture_revision_rebuilds_only_dependents...` 扩展 LOD/culling evidence 断言，事务骨架已就绪。
4. **第 10 项**：`--smoke-telemetry` JSON 报告已就位，补固定 warmup/采样窗 CLI。
5. **第 16 项**：`GpuSceneCache::budget_bytes/live_bytes/peak_live_bytes` 已就位，质量档直接消费。
6. **测试统计口径**：`cargo test` 在首个失败 target 后停止，总数用 `grep "test result:" | awk '{p+=$4; f+=$6; i+=$8}'` 汇总。

## 7. 诚实声明

- 所有"完成/通过"均以本机实测命令输出为准；GPU 证据在 RTX 4060 Laptop / Vulkan / driver 595.79 上取得。
- GPU 时间戳遥测在本机驱动返回全零（三组对照实验确认），已诚实降级并留证——换硬件后应复测。
- 一次实现弯路如实记录：纹理 revision 级联测试第一版对"解绑依赖保持材质身份"的预期错误（材质身份含全部 5 槽），真机跑挂后改两步设计——该失败本身成为新断言来源。
- 未动：正式 apps、账号/数据库/MinIO、Three 默认路径、Browser 包、共享 ABI、macOS/Linux/mobile（明确排除）。
- 未提交、未 push。工作树含并行会话（遥测/BRDF/glyph/packet_mailbox）的大量交织改动，提交时按车道拆分。
