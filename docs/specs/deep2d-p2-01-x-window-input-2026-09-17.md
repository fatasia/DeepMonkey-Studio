# Deep2D P2-01：窗口输入队列

状态：输入接线与隔离往返已完成；真实设备交互和视觉验收仍为本轮待办。

X 窗口复用已有 winit 事件入口。Enter、数字键盘 Enter、左右方向键进入 X 输入队列，不触发三维相机旋转；Esc 仍关闭宿主窗口。指针位置沿用 Deep2D letterbox 的物理→逻辑映射，留白、最小化与非有限坐标不进入内容。

## 队列语义

- 最多 64 项，仅合并连续 pointer，保留 pointer/key 的先后顺序；满队列拒绝新事件并报告错误，已有事件不丢失。
- 一个批次绑定下一次求值，新输入不会改写已发往 worker 的请求；回执等待 GPU 呈现期间的新事件留给后续 tick。
- 活动包 Arc 身份不匹配、首帧尚未呈现、会话停止时不接受输入。
- 当前封闭 ABI 的 `ReadEvent(index)` 是位置读取：有新输入时用该批事件替换包内 events，无新输入时沿用冻结 defaults。脚本访问不存在的 index 仍明确拒绝，尚不是通用 DOM 事件回调或事件总线。
- 显示列表仍由冻结调用提供；本片不新增任意脚本、点击/滚轮/IME ABI，也不承诺输入自动改变图形。

## 证据

- `cargo test --manifest-path packages/deep-engine-native/Cargo.toml --offline --bin deep-engine-native app::x_input -- --include-ignored --nocapture`：4/4，覆盖排序、合并、满队列、排空/default、留白/边界/最小化/NaN，以及真实 LPAC worker 的 pointer + Enter 回执逐项相等。
- `compat_x_window_cli --include-ignored`：3/3，原有 GPU 首帧、连续 tick、跨进程恢复和拒绝保留检查点回归通过。
- clippy `-D warnings`、fmt 与 repository gate 通过。

Design Read 沿用 FVS 等比画布与既有窗口交互；不新增配色或视觉元素。当前证据是事件队列→绑定→隔离进程和已有 GPU 回归，未覆盖实际硬件按键/鼠标端到端、截图双轮或 Kimi-95 评分。会话续期、动态显示适配器与完整交互视觉仍待。
