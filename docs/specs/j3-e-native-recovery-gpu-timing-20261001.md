# J3-E Native 恢复设备的真实 GPU 时间戳

## 现状核查

1. 已检索 Native app/renderer/telemetry 与未跟踪项。原窗口恢复具名测试、RendererFeatures.telemetry、FrameTelemetry/GpuFrameTiming 已存在；当前窗口 receipt 明确 timestamp unavailable。
2. 已读 NativeAppSetup、RendererFeatures、Renderer::telemetry_report、FrameTelemetry、GpuReadback/SegmentStats：时间戳为 opt-in，report-path 才读回；设备 epoch 与采样数已定义。
3. Cargo 固定 wgpu/winit/serde/pollster，不加依赖；生产 GPU context 已按 telemetry 请求 timestamp-query。
4. 真实消费为 NativeApp.initialize_renderer→Renderer.render_internal→FrameTelemetry；实际恢复创建不同 Renderer，features 自动继承。复用原 probe.redraw 和原报告，不能用独立 compute 耗时冒替恢复窗口帧。
5. 已读 telemetry CPU/sample-window/GPU 负例、真实窗口两fresh收据与输入隔离回归。Web 48帧时间戳已实际完成；不能据此宣称 Native 已测。
6. 已读 J3-E 权威剩余行、窗口/驱动内存/上传计时规格及续接记录。

已有（不重建）：原窗口、真实 device.destroy/lost callback、候选重建、正式逐 pass GPU 时间戳。真实缺口：冻结窗口恢复前后设备的有效采样与 receipt。新增 test-only opt-in 观察叶，环境开关仅本次测量；普通 probe 未开启时零额外 redraw，生产 handler、计时器和初始化不改。

测量窗口固定每设备追加12次原产品redraw，保存原报告（含startup样本），验证实际epoch、GPU样本数、frame时间戳和实际present计数。原HDR/相机/选择/旧代事件门不改，不拟定帧时收益阈值。初始资源上传若现有报告没有样本，保持未测，不把CPU prepare时间称GPU上传。

正式代码提升后先跑观察合同负例，再由root串行执行原具名窗口测试两fresh，开关与输出目录在finally恢复。最终统一J5保持无该开关的原验收档；WASM和源新鲜度按新测试源指纹刷新。

## 实际结果

观察叶3个合同负例通过（cross-device、缺失/零时间戳、未present/不完整窗口）；具名 `app::device_loss_probe_tests::j3_gate_e_window_events_present` 实际两个独立子进程通过。最终原始收据在 `test-output/j3-e-native-gpu-timing-20261001-final/events-round-{1,2}.json`，日志 `jc-i-20261001-native-recovery-timing-gpu-final.log`。每个旧/新设备各13个GPU frame样本（含真实startup首帧），共52个；before/after epoch分别1/2，实际adapter为RTX4060/Vulkan。

两fresh的旧设备p50为0.407552/0.410624ms，重建设备p50为0.410624/0.408576ms；p95范围0.556032–0.568320ms。原HDR恢复差0、相机/选择保持、实际lost callback及旧代事件拒绝仍通过，windowEvents.gpuTimestamp明确引用实际生产report为measured。没有帧时收益预算；测量不关闭整项。

原初始资源上传不在FrameTelemetry的packet update窗口内，四份报告packet_resource_upload均0样本；保持未测。首个CPU命令用了文件名而非实际模块名过滤，实际0-hit日志保留；已用完整模块路径重新执行并确认3 passed，不计0-hit为验证。最新Native测试源指纹对应WASM已重建、运行时产物新鲜度通过。无开关的统一strict已在这一冻结源批次通过16对32腿，degraded=false，收据`evidence-20261001081816.json`。原始计时收据8项声明源由root复用正式runtimeContentSha256独立核对，结果`jc-i-20261001-native-timing-source-verified.json`。
