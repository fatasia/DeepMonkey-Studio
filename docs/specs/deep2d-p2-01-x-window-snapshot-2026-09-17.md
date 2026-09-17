# Deep2D X 快照窗口与呈现后恢复

状态：窗口首帧与恢复切片已实现；窗口持续 tick/输入和视觉验收仍为本轮待办。

## 入口与事务

`--x-package <v6.json>` 显式执行 X 包并在现有 Native Viewer 展示成功输出的 display layer。`--smoke-x-package` 使用既有真实 surface 冒烟流程。普通包入口仍拒绝 v6，只有诊断消息而没有 display layer 的 X 包明确拒绝窗口打开。

加载/恢复逻辑抽为 `x_package_source`，headless 与窗口复用同一份整包/hash/index 校验。窗口仍只调用固定包内 worker，经真实 LPAC 和 scheduler 得到输出，再交给 `PlayerContent` 与生产 Renderer；没有新增 renderer、shader 或 loader。

窗口快照使用独立的 `DeepEngineNative/x-window-recovery` 缓存目录，与 headless 求值快照分开。首次有效输出只登记 `pending_x_lkg`；首帧启用既有 GPU error scopes、提交完成检查，只有 `RenderOutcome::Presented` 后调用既有原子 `commit_x`。headless 成功、预检成功、无 layer、坏候选均不能提升窗口检查点。源损坏时只恢复同源、已呈现过的 X 快照，重新校验并重新执行 LPAC；恢复不重复提升检查点。

## 验证

- 新 CLI 非 GPU 测试通过：headless 已建立快照，但源损坏时窗口恢复仍拒绝；无绘制输出拒绝且无窗口缓存目录。
- 实际 Windows GPU surface 测试通过：primary 首次呈现→检查点提交→破坏源文件→新进程恢复且 GPU scopes/callbacks clean；再破坏索引则明确拒绝。
- 原产品 X headless/ticks/LKG CLI 回归 1 项通过，普通包 LKG 预检回归 1 项通过。
- Native bin 110 项通过、35 个设备/GPU 专项保持显式 ignore；新窗口 GPU 测试已单独执行。clippy/fmt/repository gate 通过。

```powershell
cargo test --manifest-path packages/deep-engine-native/Cargo.toml --test compat_x_window_cli --offline
cargo test --manifest-path packages/deep-engine-native/Cargo.toml --test compat_x_window_cli --offline -- --ignored --test-threads=1 --nocapture
```

## 边界

当前展示一次求值的快照；持续 worker 已存在，但普通窗口尚未接其 tick、真实输入与更新取消。不得把此入口称为完整动态脚本播放器。

本片实跑的是既有 64×64 离屏位置的真实 swapchain smoke，不是 960×640 常规窗口的用户体验验收。浏览器双主题/双尺寸、普通窗口截图及 `design-taste-digitaltwin` 十维评分未完成；产品视觉继续沿用既有 Viewer、Unity/FVS 对标和 `base.css` 令牌，不给未实测项评分。
