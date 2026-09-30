# J3 Gate E：真实窗口恢复与 Web 产品回退

本刀扩展已通过的 headless device-epoch 门，验证生产窗口/产品桥的失去设备后处置。实际注入仍为 `destroyed`；`unknown` 驱动故障另列。

## 现状核查

1. **源码与未跟踪。** 检索 packages/apps 的 `device.lost`、`GpuEvent::DeviceLost`、`onDeviceRecreated`、`onFatalLoss`、`set_device_lost_callback` 并检查未跟踪文件。已有 Web DeviceSession/PbrRenderer/DeepWebGpuBackend/StudioDeepWebGpuBridge 与 Native gpu_context/NativeApp/recovery；不重建恢复状态机或第二套 renderer。
2. **契约。** `DeviceState`、`DeviceRecoveryOptions/Event/Snapshot`、`GpuEvent`、renderer-id 过滤、Runtime Package/RenderPacket 与现 Gate E epoch manifest 已定义。恢复后 CPU 状态与真正有效帧不是同一完成点。contracts 层无额外 GPU recovery 类型需要复制。
3. **依赖。** 现 wgpu/winit/pollster、Playwright、WebGPU 及生产资源读回足够。Native 已有 child-process 隔离和 `EventLoopBuilderExtWindows::with_any_thread` GPU 窗口测试；不加驱动故障工具或新依赖。
4. **消费。** Native 真 callback 经 EventLoopProxy 进入 `app/recovery::handle`，非 smoke/verification 模式丢弃旧 Renderer 后 `initialize_renderer`。Web 产品桥真实订阅 fatal/recreated 回调并消费 CPU 作者场景与候选首帧发布事务。
5. **测试/证据。** 已有 DeviceSession recovery doubles 检验 unknown/retry/retire/dispose，现 Gate E GPU 实测 destroy/观察/重开/重传有效帧。Native RT recovery 测试是在同 device drop/rebuild 资源；未覆盖实际 NativeApp 窗口事件。`app/package_drop_probe_tests` 已实际驱动 window/drop/present/last-good，可复用事件循环装配。
6. **规格。** 对照 `J3-双端RenderPacket对拍门规格-20260929.md`、Gate E lifecycle/device-recovery/spec 及 09-30 handoff：前两刀分别 CPU 生命周期及实际 headless 设备 epoch。窗口 present、Web 产品 fallback、unknown 自动恢复、驱动显存与时间测量尚未由这些证据认证。

### 已有（不重建）

实际 lost 观察、生产 host 重开与同包上传、错误/超时/非空/两轮稳定门、Renderer-id 过滤、窗口初始化/首帧发布、Web 作者 Canvas 及一次性回退事务均已存在。

### 真实缺口

Native `smoke_frame` 或 verification 模式遇 lost 会直接失败退出；窗口恢复测试必须使用正常 NativeApp，才能消费实际重建策略。旧 renderer 的真实 device 必须在生产 owner 仍驻留时销毁；注入后等待真实 callback，再检查新 renderer id、last-good package/view、实际 `Presented` 与 HDR 读回。陈旧 renderer-id 事件须保持现过滤行为。

Web `destroyed` 是不可恢复原因，生产预期为 fatal → 产品 WebGL fallback；不能把该 reason 改成 unknown 来演示自动恢复。另有源码确认的通知缺口：当 recovery 配置缺省，DeviceSession.observeDeviceLost 只修改 lost 状态/diagnostics；现 onFatalLoss listeners 未被调用。StudioDeepWebGpuBridge 因 session 已有 onFatalLoss API 而不订阅 legacy lost Promise，静止画面因此缺少立即通知。拟最小修复是沿已有 `fatalLoss` 路径通知一次，disposed 保持静默；先补已有单测再验证实际产品桥回退。

unknown 恢复另有尚未实测的资源图风险：DeviceSession 换 device 并清账本后，PbrRenderer.rebuildAfterRecovery 仅重 setPacketValidated；readonly pipelines/frameBuffer/output/environment/shadow/material layout 及 PacketBuffers caches 仍由旧 device 创建。DeepWebGpuBackend.runtime readonly、产品 onDeviceRecreated 仅重绘，没有上层完整替换，不能以 DeviceSession doubles 称完整 renderer 自动恢复已通过。

## 最小下一刀

优先 Native 真窗口事件腿与 Web destroyed 真产品 fallback 腿。Native 复用已有子进程/winit NativeApp GPU 测试装配；仅增加测试 accessor/readback，生产策略保持。Web 复用真实 ViewerEngine + StudioDeepWebGpuBridge，显式关闭 recovery 以覆盖现通知缺口，实际 destroy/Promise 到达后确认作者 WebGL Canvas 已接回、CPU 作者场景/相机仍在、fallback 仅一次且 late loss/dispose 不复活。

unknown 资源图修复应由完整宿主替换承担，复用已有候选创建/验证/发布事务，并停止同时使用旧资源图的局部 rehydration。只清 PacketBuffers cache 无法处理旧 pipeline/bind group。`pbrRenderer` 当前属于 I-C26 专线锁，本刀先报告不修改；完整修复先取锁、补跨 device 资源失败回归，再落生产接线。没有真实 unknown 驱动失效来源时，只能明确保留该注入项。

## 拟锁与验收

新增本规格、Native cfg(test)窗口 GPU probe/support 与最小注册；Web 真实产品 fallback lab/runner。通知修复须主线额外确认 `deviceSession.ts` 与现 `deviceSession.recovery.test.ts` 锁。不得修改正在最终 J5 验证的 HDR/C8/I 源。

同 manifest/package identity、阶段在实际动作/回调/Presented 后记录；设备/renderer 身份确实改变、非空有效 HDR/作者帧、last-good 状态保留、有限超时、错误 scope 清晰。Windows 真窗口 destroyed 自动重建与 Web destroyed fatal 回退为合法不同策略；不强制统一为假恢复。所有 Cargo/GPU由主线串行，视觉仅深色1920×1080。

## 本刀验证

Native 实际命令：`cargo test --manifest-path packages/deep-engine-native/Cargo.toml --bin deep-engine-native j3_gate_e_actual_window_device_loss -- --ignored --nocapture`，通过两个独立子进程。正常 NativeApp（smoke=false、verification=None）真实创建1920×1080窗口；生产 Renderer 的实际 device.destroy 触发原 wgpu callback，经 GpuEvent/NativeApp recovery 后 renderer id 1→2。重新走产品首帧发布事务，再取实际 Presented 与 resolved HDR；两轮重建前/后 luminance sum 均146212.95998221668、相对差0。作者 view、selection 与 active runtime package hash 保留；旧 renderer-id 的显式 lost/error负例被现生产过滤拒绝。负例与真实callback分开计数，每轮实际callbacks=1。预注册HDR相对阈值1e-6，timeout45s；CPU/HDR读回不作为驱动显存测量。

证据：`test-output/interrupted-0930/j3-window-native-run.log` 与 `test-output/interrupted-0930/window-recovery/native/round-{1,2}.json`；package hash `7089eba4ab7d3f5dfc8eaf49904b7367fdcd75db4d978075fa60aee14326744c`。输出保留 active package，不涉及磁盘恢复档新写入。

Web 非recovery lost 通知缺口已通过现 DeviceSession 聚焦回归：2文件26测通过，其中 unknown/destroyed省略recovery、一次通知与消费者重入dispose为新增覆盖；11个classification测试另由主线跑过。Web类型检查和脚本语法/rustfmt/diff通过。

Chrome本次两fresh真实ViewerEngine/StudioDeepWebGpuBridge实例通过：实际device.destroy→actual lost.reason=destroyed、recovery=null→fatal通知1次→产品failure1次→WebGL作者Canvas接回；每轮session拥有85资源→0、session=disposed、DeepCanvas=0、重复destroy/dispose保持WebGL。作者box身份、相机数组与实际WebGL readback摘要完全保留（1800×880、RGB sum200012896）；GPU errors为空、两轮全部记录一致。产品候选走真实create/上传/首帧验证后发布，没有用runtime替身。

fixture显式使用现合法无显示域雾、无地面网格profile。第一轮初始准备准确被现雾/网格能力门拒绝；修正测试输入后通过，产品门没有放宽。已查看两轮Deep/fallback共4张dark1920×1080截图：box可见、位置不变、作者回退可见；Deep/Three材质亮度与editor light helper差异属于各自宿主，未宣称双端画质像素相等或整体产品画质验收。证据`test-output/interrupted-0930/j3-window-web-run.log`、`window-recovery/evidence.json`及`web-{1,2}-{deep,fallback}.png`。

完整入口 `node scripts/j3-window-recovery-parity.mjs` 默认删除旧具名Native receipts，执行两fresh child并检查具名测试/非零passed，再运行两Chrome产品实例，产物currentRun=true。`--web-only`仅运行Chrome、合并先前显式Native receipts，产物currentRun=false且native=prior-explicit-receipts，不能当双端当次门。主线本轮先跑Native再跑Chrome定位，引用各实际日志即可；后续J5只执行默认入口一次，不重复无变化定位。
