# Deep2D P2-02：X 同窗包替换

状态：显式 X 窗口拖放替换已完成；自动热同步、隔离动态求值与完整视觉仍待。

使用 `--x-package` 打开窗口后，可将另一个 X v6 包拖入当前窗口。复用既有 PackageOpen 后台合并队列、候选 GPU 校验和失败保留机制；只替换该窗口的加载器，不给普通 N0 窗口开放 X。

## 行为

- 冻结包由 X 加载器校验并通过 LPAC 求值后成为候选，GPU 校验失败不替换活动内容。
- 成功后沿用当前窗口与 renderer；首帧真正呈现后才写 X 恢复检查点。
- 新包的 Arc 身份与旧 tick 分离，旧会话按既有生命周期取消回收。后台读取期间当前画面和 tick 保持可用。
- 普通包不进入 X 专用拖放加载器；普通窗口仍拒绝 X v6。smoke/live 模式仍禁用用户拖放。
- 坏包保留当前场景；若该路径已有有效 X 恢复记录，继续遵守现有路径绑定恢复语义。

## 验证

`cargo test --manifest-path packages/deep-engine-native/Cargo.toml --offline --bin deep-engine-native app::x_drop_tests -- --include-ignored --nocapture`：真实 RTX 4060/Vulkan、960×540 winit surface。同一窗口/renderer 接受两个不同显示包，逐次呈现并保存检查点，随后拒绝坏 JSON 和普通包，显示内容保持最后成功值；普通加载器对 X 的拒绝也已断言。

`bun scripts/verify-zrender-x-native.mts`：另外把真实 ECharts 三帧包送入上述同窗流程，初帧→单柱更新→删柱通过。原有各包 LPAC 回执逐项比较和独立 GPU 首帧也通过。脚本报告新增 sameWindow 结果，产物仅写 `test-output`。

bin 回归：113 passed / 38 ignored；上述同窗 GPU 用例另行显式执行。clippy、fmt、repository gate 通过。

本片测试以事件注入驱动真实原生窗口，不是物理鼠标拖拽或截图视觉证据。未增加监听器；自动文件热同步、进程内 ECharts/JS、像素差分和 Kimi-95 双轮视觉仍为本轮待办。
