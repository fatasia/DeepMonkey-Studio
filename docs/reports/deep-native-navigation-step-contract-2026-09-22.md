# Deep Native 导航步进合同（2026-09-22）

本次增量把现有 `RuntimeCameraControls` 的第一人称/第三人称运动规则抽成可复用的确定性步进模块，并接入 Native 窗口输入、重绘帧时钟和既有三角碰撞消费。

已覆盖：

- 前后与横向输入归一，避免对角线加速；
- 步行、冲刺和第三人称速度；
- fly 垂直轴；
- 有界帧间隔、重力、跳跃、落地与眼高保持。

验证：`cargo test runtime_navigation --manifest-path packages/deep-engine-native/Cargo.toml --lib`，5/5 通过；Native bin 的导航/相机定向测试 4/4 通过。

边界：Native 已消费真实键盘状态、重绘帧时钟与既有三角扫描碰撞；仍未实现 Web 字段中的 floor probe、step-up 和 slope solver，因此 `stepHeight>0` 或 `maxSlopeAngleDegrees>0` 精确阻断，不能把这一步扩大为完整 Web 导航等价。

后续正确性修复：按 `eye = target - distance × basis[2]` 复核后，纠正前进轴符号；原测试固定数值也沿用了错误方向，现新增不同 yaw 下与实际 eye→target 向量的点积/共线检查。零、负数及非有限 dt 不再改变跳跃速度或地面状态。新增回归后同一命令 5/5 通过。

### 窗口输入接线

复用现有 winit `WindowEvent`、`NativeApp` redraw 时钟和 `resolve_camera_motion`：第一/第三人称模式现在接收 WASD、QE（飞行垂直）、Shift 冲刺、Space 跳跃；按键按下/释放使用集合维护，窗口失焦清空输入和导航状态。orbit 模式完全走原有处理。首个 redraw 没有有效 dt 时会继续请求 redraw，避免按下键后运动停在零 dt 首帧。`cargo check --bin deep-engine-native` 与导航/相机回归通过。

### 发布门禁边界

`runtime_camera::validate_native_support` 已允许步高/坡度为零的 firstPerson/thirdPerson 进入 PlayerContent；带 Web 地面求解字段的场景仍返回精确原因。上层 Web 发布兼容映射尚未同步该能力，因此正式发布前仍需完成编译证据和发布预检接线；工具栏目前继续复用 Native 键盘/鼠标操作（1–9 视图、M 测量、C/X/Y/Z/PageUp/PageDown 剖切、Home 复位、点击选择聚焦、F11 全屏），没有新增第二套 Native 工具栏 UI。
