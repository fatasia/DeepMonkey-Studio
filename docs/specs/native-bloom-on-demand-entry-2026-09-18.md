# Native 生产入口 Bloom 按需分配（P1-09 收尾）

e9d004f 后 ForwardTargets 已可紧凑，但生产入口硬编码默认 Bloom（enabled+intensity 0.14），纯二维 dashboard 组合包仍无条件获得全尺寸 Bloom 链与全尺寸前向目标。本片把"Bloom 目标默认完整分配"改为"按需分配"：纯二维内容的生产入口不再代用户启用 Bloom。

## 实现与裁剪条件

- 判据同源：`content_profile::entry_bloom(content)` 复用 `plain_2d_content`（deep2d 就位且无实例）；`planeless` 改为该事实加探针否决，语义不变。
- 三入口统一：`--package` 系（runtime_package_startup::run）、发布验证（verify）、`--package-live` 热更观察全部走 `entry_bloom`，冷启动与热更不分叉。
- Bloom 关闭时 `BloomPass::new` 返回 None（零分配，优于 1×1），`compact_forward` 判据随即把 ForwardTargets 紧凑为 1×1；Bloom 开启的内容保持全尺寸链，路径代码零改动。
- 不发明新状态：包 schema 无 bloom 字段，Bloom 仍是入口构造参数；显式关闭仍走 `--no-bloom`。

## 预算口径

`forward_target_bytes_per_pixel()` 保持修正后 56 B/px（8+(8+4)×4），1280×720 全尺寸 51,609,600 B；紧凑档位为 56 B。该数值是三纹理逻辑估算，非物理显存测量；本片不宣称整进程显存或 FPS 提升。全尺寸 Bloom 链另有 3×Rgba16Float 半分辨率目标（全屏等效约 6 B/px，1280×720 约 5.5 MB），仅存在于 Bloom 激活档位。

## 像素等价（GPU 读回，tests/p09_forward_trim_gpu.rs，RTX 4060 Laptop/Vulkan）

生产链组装（MSAA clear/resolve → BloomPass → OutputPass）两种入口档位对照：暗色 dashboard 背景（2 尺寸 × 2 输出格式）全尺寸链与 1×1 紧凑链逐像素一致；HDR 亮背景两链输出不同，证明 harness 有区分力、Bloom 路径真实生效。修复前后各跑一轮，16 个读回文件 SHA256 全部一致（test-output/p09-forward-trim-20260918/）。draw_in_format 组合包对照：dashboard golden、atlas tint、letterbox、真实 producer 包（dashboard-http-multicomponent-20260917）、author-css-colors 全部通过；compact_forward_output_gpu 40 组 41,032 像素继续一致；bloom_gpu NVIDIA 探针通过。

## 回归

bin 127 项通过（含新增 entry_bloom 档位测试）、lib 341 项通过；clippy -D warnings --all-targets --all-features 通过；cargo fmt 干净。GPU ignored 抽跑 p09/bloom_gpu/compact_forward/dashboard 组/producer/author-css-colors 全绿。

## 边界与遗留

- 纯二维 + 超阈值 HDR 亮背景且走生产入口的组合包，不再叠加默认 Bloom（该形态不属 dashboard 生产包；需要者走 `--packet` 观察路径或显式开启）。
- `--package-live` 热更把纯二维内容换成含实例内容时，renderer 重建沿用入口定格的 Bloom 档位，不自动恢复默认，需重启进程；与紧凑档位"跨档由完整重建处理"的既有纪律一致。
- render-packet 冒烟/观察入口（`--smoke-*`、`--fog`、section/selection/telemetry/chart-keyboard）保持默认 Bloom，不在本片裁剪范围。
- producer letterbox GPU 测试依赖 DEEP_DASHBOARD_PACKAGE_PATH 外部包路径，本机以 dashboard-http-multicomponent-20260917 复跑通过。
