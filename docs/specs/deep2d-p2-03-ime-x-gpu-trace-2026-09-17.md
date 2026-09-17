# 中文提交轨迹经 X 隔离进程的 GPU 对照

日期：2026-09-17。状态：跨进程显示一致性切片已完成，P2-03 仍待办。

复用冻结 `deep2d-rich-text-ime-trace-v1.json`（canonical SHA-256 `c5c5ac85f2fb3c411aa75bf09baadd0f84beea9b6fb02b674b5563c0e4171b3d`），实际调用 N0 ImeSession 的 focus/preedit/commit/cancel/caret/blur。只有三次成功 commit 进入显示链，未提交组合与错误操作不修改文档。

三次文本为“泵运行e”、“泵运行é”、“泵运行é👩‍🔧”，revision 为 2/3/4。cosmic-text 0.19.0 使用本机已安装 Microsoft YaHei 及系统 fallback 栅格化，生成宿主 atlas。atlas 经实际 LPAC worker 求值、回执校验和宿主 epoch 发布后，交给现有 GPU Painter；与不经过 worker 的 N0 Painter 逐像素比较。

## 验证

- `cargo test --manifest-path packages/deep-engine-native/Cargo.toml --offline --test compat_x_display_gpu -- --ignored --nocapture`：2 passed；既有三角形对照同时通过。
- RTX 4060 Laptop / Vulkan：三帧各 320×180、57,600 像素，差异均为 0；每帧非背景像素大于 50，完整 atlas 字节与资源合同往返相等。
- 三次过期 epoch 回执均拒绝，重新读回旧 Painter 得到相同像素；会话显式关闭。
- 原离线 IME/N1 轨迹 1 项、N1 adapter 12 项回归通过；专项 clippy `-D warnings`、fmt、repository gate 通过。
- 首轮测试末尾误写四次提交，实际冻结夹具为三次；修正测试计数后完整重跑通过，没有更改夹具或像素断言。

## 范围

本片是同一宿主字体结果跨 IPC/GPU 的一致性证明，不是独立字体形状真值，也未证明跨机器字体相同。字体未打包或再分发；X 只接收封闭 atlas display，不执行字体查询或任意 JS。Windows 实际候选窗、TSF/键盘输入、DPI、bidi/换行视觉、formatter/动画与超时组合轨迹仍待办；离屏读回不替代两轮窗口视觉验收。
