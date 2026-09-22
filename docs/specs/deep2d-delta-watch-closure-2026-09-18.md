# Deep2D delta watch 与呈现检查点收尾

状态：已完成本切片。P3-01 标准包 delta 已接入 `--package-live`；实验 X v6 继续走原专用入口。

## 实现与根因

- watch 根据 schema 分派完整包或 delta。delta 只使用与活动包 ID/hash 一致的已呈现 LKG，重建完整包后复用资源 diff、GPU 预热、present 和检查点提交。
- 修复普通 live 完整包更新未携带 `pending_lkg`：此前窗口可变更而磁盘检查点停在旧版本。完整包与 delta 现在都只在成功 present 后提交完整字节。
- live 冷启动复用 `load_auto`。源已被替换为 delta 或坏包时，可从该源专属 LKG 恢复；首次启动仍需完整包或已有已呈现检查点。
- 活动 hash 变更时重新检查未变文件；LKG 暂不可用/尚未追上活动 hash 时保留可重试状态，防止先到 delta 被文件元数据去重永久吞掉。
- 后台准备与重试都复核 delta 基线，避免准备期间其他包已呈现后旧 delta 反向覆盖。

## 验证

- watch 10 项，包括完整包/delta 检查点、迟到幂等、截断、缺操作、坏 hash、不兼容 schema、错误基线、跨重启恢复与原有锁/输入预算测试。
- 标准 delta 合同 16/16；本轮最终 Native lib 362 通过/1 显式忽略，bin 136 通过/51 显式忽略（包含同期 UIA/IME 收尾）。
- 两项 Windows GPU surface 用例已显式执行：scene delta 与 Deep2D delta 均使用真实文件监听线程及生产 PackageArrived 事件入口，在 RTX 4060 Laptop / Vulkan 上通过文件替换→零尺寸暂缓→恢复→真实 present→完整 LKG 提交→坏候选/迟到拒绝→重启恢复。
- `cargo clippy --all-targets --all-features -- -D warnings`、fmt 与 all-target 检查通过。
- CPU 与合同日志：`test-output/deep2d-codex-native-cpu-20260918.log`、`test-output/deep2d-codex-delta-contract-20260918.log`。

复跑：`cargo test --manifest-path packages/deep-engine-native/Cargo.toml --bin deep-engine-native delta_present_tests -- --ignored --nocapture --test-threads=1`。

## 设备矩阵结构收尾

`scripts/p03-04-device-matrix/harness/src/main.rs` 原 956 行，按后端矩阵、GPU 读回、像素比较、字体来源、字体矩阵和设备恢复分为 7 个职责模块，主入口 188 行，所有新增模块低于 300 行。

相同生产包和冻结字体重跑 6 后端/尺寸格、4 字体格及 Vulkan/DX12 destroy→重建。12 份 RGBA 的 SHA-256 与原证据全部一致，跨后端差异 0 像素，两个后端恢复重复帧逐字节一致。新产物在 `test-output/p03-04-device-matrix-codex-20260918/`，保留原证据目录。该独立 harness 保留既有 3 项 private_interfaces 编译警告；生产 Native clippy 无警告。

本切片无绘制样式或布局变更；未扩大为多设备、真人 Narrator、真实 Windows IME 或全项目视觉验收。
