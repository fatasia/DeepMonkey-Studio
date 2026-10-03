# J3-E 产品恢复的上传、GPU 帧时与驱动内存

## 现状核查

1. 已检查完整产品候选恢复 probe、PbrRenderer/GpuTimer、上传 markers、未跟踪测试和驱动采样器。复用已有恢复与计时链。
2. DeviceSession/FrameMetrics 合同已有可选 timestamp-query、逐 pass 实测 frame；资源账本与驱动进程计数分别记录。
3. 使用已固定的 Vite、Playwright、Chrome、wgpu 和 Windows PDH，无新增依赖。
4. 真实消费方是 StudioDeepWebGpuBridge 与 Viewer：setGpuTimingEnabled(true) 通过现有产品性能开关启用采样，并由重建候选继承。
5. 已读既有 GPU timer、optional feature 回退、恢复窗口、驱动内存证据。新观察器有 typed-array 范围、原调用语义、frame 去重及 descriptor 恢复负例；驱动四阶段已有五组 CPU 检查。
6. 已读 J3-E 权威剩余行、恢复元数据、窗口、驱动内存规格与续接台账。

已有（不重建）：完整候选替换、上传、逐 pass 时间戳、销毁账本、PDH 驱动进程采样。真实缺口：同一真实恢复前后设备的有效计时窗口和四阶段驱动内存观测。观察器留在 ignored test-output，生产恢复模块不改。

## 实际 GPU 时间戳与上传调用

`test-output/j3-e-recovery-timing-20261001/run-2026-10-01T07-37-13-150Z/evidence.json` 保存两次独立浏览器、每次两个真实设备，每设备 12 个有效 timestamp frame，共 48 帧。正式源码与观察器执行前后哈希一致，原 queue 调用的 this、参数及失败语义保持。

四设备首帧为 5.636096、5.570560、5.570560、5.832704 ms；各自排除前两实测帧后的区间为 0.458752–0.589824 ms，中位数均 0.524288 ms。这是该冻结恢复场景的 GPU pass 总时间，不是产品整帧墙钟或工业场景性能预算。

原设备 writeBuffer 为 337/331 次，源范围 216516/215844 字节；两个替换设备均 325 次、215172 字节。每设备一次 writeTexture，源数据均 4194304 字节。记录的是提交调用的源数据范围，不能视为实际总线传输或显存占用。原始逐 pass、全部 frame、发布 markers 和摄像机/作者像素身份随 receipt 保存。

静置需求渲染导致帧数不足、仅 query 启用但产品性能开关关闭导致实测 frame 停在 1/2 的两次失败均保留。最终使用已有 requestRender 与 setGpuTimingEnabled(true)，没有改动计时核。

## 四阶段驱动内存

两个 fresh 的证据分别在 `test-output/j3-e-driver-memory-phases-20261001/run-2026-10-01T07-09-25-455Z/evidence.json` 与 `run-2026-10-01T07-12-14-333Z/evidence.json`。每轮同一个存活 Chrome 进程树依次采样作者 WebGL 基线、Deep 发布、替换候选发布、Viewer/bridge 销毁，每窗口三次 PDH 样本。不存在的进程没有按零值补齐。

候选替换后的驱动计数变化为 −4763648/−4751360 字节；销毁后相对 WebGL 基线仍有 16654336/17735680 字节。实际旧设备资源归零、新设备恢复 85 项，最终两个 session 均 disposed，资源与账本字节归零。驱动残留没有等同于泄漏，也没有据此宣称零显存：driverLeakBudgetBytes=null，判定为 calibration-pending。

## 验收边界

measurementPassed/observationPassed 均为 true；Gate E 仍开放。当前刺激是 synthetic recreated notification 配合真实 GPU 候选替换，未涵盖实际未知驱动故障；Native 上传/计时、驱动残留预算与完整编辑域仍须分别完成。源哈希 receipt 证明测量当时身份，后续 I16 正式提升后不可把它称为新源重跑。

后续Native独立测量已完成真实窗口恢复两fresh共52个GPU时间戳，并经8声明源独立核对，见[Native实际测量](j3-e-native-recovery-gpu-timing-20261001.md)。初始上传仍0样本，未知驱动故障与驱动残留预算未关闭；不把两个冻结批次合称一次新运行。
