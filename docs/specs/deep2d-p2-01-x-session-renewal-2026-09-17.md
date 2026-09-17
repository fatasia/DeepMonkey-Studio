# Deep2D P2-01：X 窗口会话续期

状态：后台会话续期切片已完成；动态显示与完整产品验收仍为本轮待办。

窗口不再在第 1024 次成功 tick 后永久停止。后台线程在第 1025 次请求到来时先关闭并回收原 LPAC 会话，再由既有 scheduler 创建下一会话。epoch、时钟、输入队列与已呈现内容仍由窗口宿主持有，不随进程更换重置。

## 不变项

- 只有成功完成 1024 次请求的会话可以正常续期；单次失败、超时、CPU 超限、坏 hash/回执均终止后台线程，不自动重发。
- 每个会话仍使用原有 LPAC capability、Job 内存/累计 CPU 限额和每请求预算；不增大预算，不更换 worker 路径来源。
- 先回收旧进程再创建新进程，任何时刻只有一个 worker；续期发生在后台线程，UI 保留原帧。
- 关闭窗口可以取消已排队/在途求值，重复关闭幂等，关闭后无法继续提交。

## 实测

`cargo test --manifest-path packages/deep-engine-native/Cargo.toml --offline --bin deep-engine-native app::x_transport -- --include-ignored --nocapture`：通过，连续 1025 次真实 LPAC 请求，前 1024 次同 PID，第 1025 次新 PID；旧 PID 已结束，关闭后新 PID 也已结束。逐次 epoch 与时钟范围核验，重复在途提交拒绝。

测试另覆盖排队后取消、重复 close、关闭后提交拒绝、损坏 request hash 导致线程自行终止且不能接受新请求。两轮各约 2.6 秒；这是轻量 ReadClock 求值，不是 GPU 帧率或复杂脚本性能指标。

窗口 GPU/恢复/失败回归 `compat_x_window_cli --include-ignored`：3/3；clippy、fmt、repository gate 通过。原始 session 独立进程上限不变；变化的是窗口宿主的正常会话生命周期。

仍待：产生变化显示列表的动态适配器、真实设备输入端到端、正常窗口视觉验收与 P2/P3 其余整卡要求。本片没有新增 UI 或视觉样式。
