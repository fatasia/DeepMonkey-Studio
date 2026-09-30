# J3 Gate E：Native 正常窗口设备恢复重试

正常 Native 窗口在设备丢失后已自动重建；本刀补重建失败后的有限退避重试，保留作者包、视图和手动 R。

## 现状核查

1. 全仓 packages/apps src、未跟踪源已查 device.lost、recovery、retry、initialize_renderer。Web DeviceSession 的 unknown 分类/退避/设备重开、Bridge 完整候选创建与首帧发布已在生产使用；I-C23 在途 DeviceSession 只扩 requiredLimits，不改 loss 状态机。本刀不重复 Web 恢复或改 C8 shader。
2. 契约：DeviceRecoveryOptions/Event/Snapshot、Native GpuEvent/renderer id、PlayerState、PublishedState、RenderOutcome::Presented 已有。Native 没有窗口设备重建失败的预算/期限字段；StartupFrameTimeout 是首帧显示重试，不是 requestDevice 重试。
3. 依赖：wgpu/winit/pollster/web-time、NativeApp about_to_wait、ControlFlow::WaitUntil 已在用；不增加依赖、线程、GPU事件类型或恢复平台。
4. 消费：app/recovery::handle 过滤旧 renderer-id，正常窗口收到真实 DeviceLost 后释放旧 Renderer 并 initialize_renderer。renderer_lifecycle::initialize_renderer 失败后 state.failed、窗口提示按 R，当前无第二次自动尝试；首次启动/手动 R 保持原行为。Web 相同题目已有生产闭环与 CPU 失败/重试/耗尽覆盖。
5. 测试与证据：现两 fresh Native 窗口实际 destroy→callback→renderer1→2→Presented/HDR 门已通过；Web destroyed 回退、完整候选成功/失败两 fresh 已通过。Web epoch 通知刺激是明确模拟，真实 driver unknown 未认证。现窗口 probe 可复用；不重跑无变化矩阵、不声称 driver 显存。
6. 规格：读 Gate E window/current-state、epoch replacement/failure、J5 window suite、0930 handoff、恢复账本和权威剩余清单。保留已有真实丢失/重开证据，后继仅认证新增失败重试边界。

**已有（不重建）**：Web opt-in 自动 loss 分类/重试/完整产品候选，Native 实际回调、renderer-id 过滤、旧图释放、相同作者包/视图上传、首帧发布和手动 R。

**真实缺口**：Native 正常窗口第一次 Renderer::new 失败后停止自动重建；设备创建成功、尚未 Presented 时再次丢失，也没有跨候选的有限预算。

## 最小生产接线

仅正常窗口的 active DeviceLost 开启窗口级 retry budget。最多3次创建尝试，第1次立即；第1/2次失败后分别等待250/500ms。正常首次启动、smoke/verification、手动 R 和 WASM 保持现策略。手动 R 或其它明确重新初始化取消旧恢复 deadline；关闭窗口后不再调度。

复用 about_to_wait 和 ControlFlow::WaitUntil，deadline 与现动态/物理/已有唤醒合并取最早值。无轮询忙等、无新增等待线程/GpuEvent。Renderer::new Ok 仅记录候选 renderer id，实际 RenderOutcome::Presented 才清预算；首帧前再次 loss 沿当前预算，不无限重置。旧 id 丢失、陈旧 deadline、重复回调不能生成新设备。预算耗尽保留失败诊断与 R 入口。

重建仍走原 Renderer::new 和内容上传，不复制 renderer，不改变包/相机/选择、不复用失效旧图。仅首次失败后的自动调度发生变化。

## 验证预登记

独立 CPU 叶覆盖：立即首尝试、250/500ms退避、期限前不尝试、恰3次后停止、创建成功不清预算、匹配 Presented 才完成、错误 renderer-id 不完成、首帧前反复 loss 不能刷新预算、手动取消与迟到 deadline 拒绝。已有真窗口成功门不另改阈值。

实际增量复用现 `device_loss_probe_tests` 两 fresh 子进程：已发布旧 Renderer 的实际 device.destroy/真实 lost callback 后，在第一次重建的测试接缝注入明确创建失败，再由生产 deadline 自动重建真实新 Renderer、上传同包并 Presented。要求真实 callback1次、创建尝试2次、失败注入1次、旧 renderer-id 拒绝；同包 hash、view、selection 保留；实际 resolved HDR 相对差≤1e-6，45s超时不变。失败注入是测试刺激，设备和最终帧均真实，不认证真实 unknown driver fault。

## 源与验证状态

生产接线已落地：`recovery_retry.rs`仅保存正常窗口预算、candidate id、deadline及本模块安装的唤醒；手动初始化cancel预算，普通DeviceLost沿既有路径释放旧图并开启预算。生命周期在about_to_wait执行到期尝试，消费自己旧WaitUntil并保留Poll/未到期更早动画wake；匹配Presented清预算。第3次创建失败立即记录耗尽次数和原始错误。WASM仍走原重建路径。

独立CPU叶共5项，包括已过期动画WaitUntil必须被消费的忙等反例。实际增量入口为`app::device_loss_probe_tests::j3_gate_e_actual_window_device_loss_retry`，原无失败注入入口保持。复用同窗口probe、两fresh子进程，`cfg(test)`实例计数器只在恢复候选创建处消费一次，随后由生产deadline创建实际Renderer。receipt写`retry-round-N.json`，sourceHash通过公开runtime_content_sha256对实际pure factory返回WGSL source的canonical JSON编码计算，`hashEncoding=canonical-json-wgsl-source`；不是raw WGSL字节SHA。

rustfmt使用skip_children=true，相关diff检查通过。root首轮CPU编译发现receipt引用lib private hash模块E0603，已改为上述公开函数，失败日志`native-recovery-retry-cpu.log`保留。尚无本刀Cargo/GPU通过结果；Cargo、实际窗口运行与GPU释放由root统一记录。

## root验证结果

5个CPU退避/预算/取消/唤醒门通过；root review补了已过期动画deadline不得保留的反例，避免恢复接线引入忙循环。两fresh真实窗口增量门通过：各轮实际device.destroy触发1次lost callback，第一次candidate创建明确注入失败，250ms生产deadline后第2次创建成功、真实同包上传与Presented；旧renderer1→新renderer3，HDR相对差0、视图/选择保留、陈旧回调拒绝。retry-round-1/2.json在test-output/interrupted-0930/native-recovery-retry，root实际11.38秒。

初次CPU编译遇到收据调用library私有hash的E0603；改用已有公开runtime_content_sha256并标canonical-json-wgsl-source，未扩大生产可见性。原失败日志native-recovery-retry-cpu.log保留，成功CPU/GPU日志为native-recovery-retry-cpu-after.log/native-recovery-retry-gpu.log。本刀关闭Native重建失败后有限重试子集；真实driver unknown、驱动显存、上传预算与完整Gate E仍后继。