# Deep2D P2-01：窗口后台 tick

状态：本切片已完成；P2-01 整卡仍为本轮待办。后续[会话续期](deep2d-p2-01-x-session-renewal-2026-09-17.md)已替代下述初版的 1024 次后停止行为。

`--x-package` 在首帧呈现后启动后台 LPAC 求值。窗口最多保留一个在途请求和一个待呈现候选；冻结 calls/resources 不变，宿主绑定递增 epoch、真实经过时间和种子。初版继续使用包内事件，真实键盘/指针输入未接入。

## 发布与资源边界

- 后台线程独占隔离会话，UI 通过容量 1 的通道取回执；完成通知唤醒窗口，无轮询忙等。
- 相同显示列表复用已呈现层，不重复创建 painter 或上传 GPU；变化层复用现有事务式 stage/present，成功才替换活动内容。
- 包身份由 Arc 绑定，切换包丢弃旧候选并关闭旧 worker；退出先取消、断开请求通道，再等待线程回收。停止状态不会自动重启。
- 保留既有每请求与累计 Job CPU 限额、1024 次会话上限。用尽后保留当前画面并提示重新打开，自动续期仍待实现，不提高既有预算。
- tick 失败不改恢复检查点。恢复记录仍只代表已成功呈现的冻结包，不表示动态 tick 全部成功。

## 验证

- `cargo test --manifest-path packages/deep-engine-native/Cargo.toml --offline --test compat_x_window_cli -- --include-ignored --nocapture`：3/3。真实 Windows GPU 主文件/跨进程恢复各 3 次 tick，epoch 10/11/12，同一 worker PID、复用原显示层，退出后 PID 已结束。
- JSON-safe 种子边界：初始帧成功并保存检查点，下一 tick 拒绝；损坏源文件后仍恢复原检查点，错误 tick 不产生新检查点。
- bin 回归：110 passed / 35 ignored；clippy `-D warnings` 通过。GPU 用例在上述聚焦命令显式执行，其他 ignored 不计通过。
- 测试增加并发唯一目录序号，修复 Windows 时钟同刻导致临时目录碰撞。

## 后续

真实输入、有界事件队列、持续会话续期、改变显示层的动态适配器以及完整窗口视觉验收仍待。当前封闭 ABI 中显示指令是冻结列表；时钟/种子更新不等于任意脚本动画。正常尺寸交互截图与 Kimi-95 验收尚未完成，本切片不宣称产品视觉完成。
