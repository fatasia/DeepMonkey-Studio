# Native 初始资源准备计时核查

23:05：六段正式启动归因已跑实际 NativeApp 原窗口探针，两 fresh 进程52个 timestamp 帧，GPU测量通过/HDR差0；四窗口资源准备1544–2015ms。逐段真实 elapsed 收据 `test-output/jc-i-20261001-j3-startup-attribution-gpu-summary.json`，原完整事件 `test-output/j3-e-startup-attribution-20261001/events-round-[12].json`。本批观察的是host elapsed，未声称纯CPU/GPU复制耗时或性能改善。原11-cell矩阵明确排除真实unknown driver fault与校准前物理VRAM leak阈值；这两项不再扩为J3-E必过门。

22:30补充：沿唯一启动origin将resourcePrepare划为六个连续host-monotonic elapsed子段，两正式叶及实际Rust5/5通过，日志 `test-output/jc-i-20261001-j3-startup-attribution-tests.log`。子段总和等于原窗口；重复、缺失、越序与越界不发布，telemetry关闭不采时。现有消费方没有子段名称白名单，恢复run.phases与帧CPU/GPU枚举不变。六步核查见 `test-output/j3-e-native-initial-source-bytes-20261001/continuation/cpu-attribution/AUDIT.md`。

该归因包含CPU调用、阻塞驱动调用、await校验和调度等待，不是纯CPU active time或GPU复制时间。本片没有实际启动GPU测量、性能改善或全源字节结论；uploadedBytes/gpuUploadTimeNs保持null，Gate E仍开放。先前52帧属于原采集源批，后继计时变化不继承旧全仓current guard。

19:48 补充：startup 最后边界移至 surface.configure 与 WASM EditorOverlay 创建之后，覆盖全部初始资源调用，随后成功返回 Renderer；其余三个叶保持。正式 CPU3/3、两 fresh 实际52 GPU帧/HDR差0通过，root 按 boundary-manifest 四源 SHA 与阶段顺序独立核验通过。收据 `test-output/jc-i-20261001-native-initial-boundary-verified.json`，日志 `native-initial-boundary-cpu.log` 与 `native-initial-boundary-window.log`。GPU copy/源字节仍为 null，Gate E 不因这项关闭。

## 现状核查

1. 检索packages/apps的upload/timestamp/packet_resource_upload与未跟踪Native叶；读取renderer/init、scene_update_stage、FrameTelemetry及真实恢复观察叶，初始资源准备已生产消费，不重建上传器。
2. 合同已定义CPU ResourcePrepare与SampleWindow.upload的host-monotonic时钟；GPU timestamp是另一路。packet_updates只计已commit更新。初始准备计时不能伪装为GPU总线传输时间。
3. 读取Cargo.toml，已有固定web-time、wgpu30、serde及Windows进程树采样设施；无需新增依赖。
4. create_renderer先CPU prepare_scene/pbr，再create_gpu_context，随后shadow/pipeline/IBL/scene_cache stage/commit/RT构建，最后才创建FrameTelemetry。后继packet更新已stage真实计时并在publish记录，初始路径没有对应样本。
5. 既有sample-window合同测明确无上传样本必须unavailable；实际恢复四份report均0样本。Web两fresh实际queue源范围与48GPU帧、Native52GPU帧已有；两者不可代替初始Native上传。旧实测和J5全绿保留。
6. 读取权威Gate E行、device recovery、Native timing、恢复测量及台账；未知驱动故障、驱动残留预算仍独立缺口。

已有（不重建）：正式上传、缓存字节/复用指标、真实更新CPU prepare、逐pass GPU timestamp和恢复窗口。真实缺口：初始资源准备阶段的独立时钟窗口与初始上传源字节完整覆盖。

直接在函数末尾向FrameTelemetry.record_packet_prepare补一条旧持续时间不成立：该telemetry的窗口在准备完成后才开始，旧阶段不在它的样本窗口内，且会把初始加载计成后继packet更新。最小后继应为初始化单独start/end窗口，定义CPU resource creation/upload-call/validation wait覆盖，成功commit才发布；失败/无telemetry不发样本。实际GPU copy耗时与驱动显存另计。先准备独立观察草案，保持C8/J3当前正式源冻结。

正式`renderer/initial_preparation.rs`将scene prepare、async device setup、resource prepare三个真实边界放在同一个独立startup窗口，显式host-monotonic、gpuUploadTimeNs/uploadedBytes为null，拒绝缺失/重复/乱序；epoch沿原u64合同允许0。只在成功Renderer构建返回前结束并留给报告路径，原FrameTelemetry窗口/packet_updates保持原语义；无telemetry不取时钟。

19:03：隔离完整Native工程编译3/3，随后真实两fresh恢复52个GPU帧、HDR差0、实际lost回调/旧事件拒绝/相机及选择保留。四startup窗口资源阶段1.398–1.587秒，均为CPU创建/上传调用/管线和validation wait覆盖，不是GPU复制耗时。root独立四源SHA、编译binary SHA、声明probe hash和全部阶段边界核验后提升四叶，正式CPU3/3及正式两fresh52帧/HDR0复跑均通过，正式源/所有阶段边界独立核验通过。收据`test-output/jc-i-20261001-native-initial-isolated-verified.json`、`native-initial-promotion.json`和`native-initial-formal-verified.json`。purity通过、engine-size2953文件175既有warning零失败；根目录800行门仍19项既有债务，本四叶均合规。初始源字节完整覆盖、unknown硬件fault与驱动残留预算仍未关闭，J3-E保持开放。
