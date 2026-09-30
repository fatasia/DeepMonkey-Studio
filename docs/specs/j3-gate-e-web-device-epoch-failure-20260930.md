# J3 Gate E：真实失败候选保持作者 WebGL

完整候选替换成功门已通过；本门追加一个实际GPU候选在产品首帧验证之前失去device的失败路径。

## 现状核查

沿用`j3-gate-e-web-device-epoch-replacement-20260930.md`的六步核查与候选失败范围，并在新增叶子前复查当前Bridge/PBR消费路径、测试与实际成功证据。

1. 源码/未跟踪：已有ViewerEngine、Bridge、真实DeepWebGpuBackend factory与DeviceSession。成功probe/runner冻结，另建测试叶子，生产恢复源不改。
2. 契约：沿用GPUDeviceLostInfo、PbrRenderer session、StudioRendererSwitchResult与作者Three对象身份；没有新增产品合同。
3. 依赖：现Three、Vite、Playwright与浏览器WebGPU足够，没有新依赖。
4. 消费：Bridge reused switchTo完整candidate事务；prepare实际首帧验证失败后dispose candidate/removeCanvas，recovery调用方一次报告failure并保留WebGL。
5. 测试/证据：已有CPU recovery失败、迟到取消/dispose与用户pending回归，实际成功替换两fresh实测。真实失败GPU candidate此前没有对应实测。
6. 规格：对照epoch替换规格及窗口真实destroyed门。这里的宿主recreated通知是明确模拟，candidate.device.destroy是真实GPU刺激，不修改reason或认证unknown驱动故障。

**已有（不重建）**：唯一产品candidate创建/上传/验证/发布/退休事务、错误报告、作者WebGL回退与资源账本。

**真实缺口**：CPU失败测试不能证明真实GPU候选的device被销毁后首帧门拒绝并完全退役。本门补实际执行证据和发现的候选缓存入场缺口。

追加源码核查发现独立RenderPacket路径会缓存validatedView/validatedFrame；prepareView在sameRenderView时直接返回缓存，没有检查session状态或创建device身份。设备在candidate创建后、Bridge订阅fatal前丢失，或恢复换device后，缓存帧不能继续作为当前设备的候选入场凭证。作者projection路径当前没有同一缓存，不改夹具camera来规避独立包缺口。现RendererDeviceEpoch已存在，复用它与已有ready状态合同，在prepareView入口拒绝不可用session/跨device旧backend；生产无新恢复事务。

## 注入与断言

实际fixture使用现ThreeProjectionBridge编译作者box为RenderPacket，沿Studio authorRenderPacket独立包输入进入实际Deep create；该路径确实缓存首帧，不修改camera绕过缓存。当前真实Deep宿主发布后，明确模拟其recreated通知。现Bridge同步切WebGL并创建新候选；原真实factory返回新PBR runtime且session=ready、资源非零时直接销毁其实际device。现prepareView首帧入场检查必须拒绝，禁止发布该候选。

断言实际两device身份不同、候选确实ready后被销毁、old与failed candidate都disposed且资源0、Deep Canvas0、WebGL可见、failure恰1、旧回调重复不生第三候选；相机、作者对象身份及1800×880 RGBA sum/FNV32指纹保留。实际old/candidate device.lost都必须为destroyed。两个fresh Chrome实例记录稳定，截图只dark1920×1080。

## 验证入口

`node scripts/j3-device-epoch-failure.mjs`输出到`test-output/interrupted-0930/epoch-failure/`。本门只运行Web，currentRun=true仅表示当前独立失败候选门；真实unknown驱动故障、驱动VRAM和恢复耗时另列。脚本语法、diff与web类型检查通过，类型日志`test-output/interrupted-0930/epoch-failure-types.log`。

缓存入场CPU回归先复现5个失败（lost/recovering/disposed/degraded及换device仍返回frame），同device对照与原46测通过，日志`epoch-cache-before.log`。最小补prepareView入口复用RendererDeviceEpoch与ready状态合同后，6个DeepWebGpuBackend测试文件122测及core类型检查通过，日志`epoch-cache-after.log`/`epoch-cache-core-types.log`。不可用候选拒绝零GPU动作，同device缓存仍不重复提交首帧。

实际独占GPU运行两fresh Chrome轮均通过，`j3-epoch-failure-run.log`与`epoch-failure/evidence.json`记录本次结果和源哈希。每轮independentPacketCandidate=true、实际不同device候选共2个；候选session原ready/84资源，真实device.destroy后实际lost.reason=destroyed、fatal通知1次，prepareView以`GPU session is not ready for candidate admission.`拒绝，产品failure恰1。old与failed candidate均disposed/资源0、Deep Canvas0、作者WebGL opacity1；重复旧通知没有第三候选。GPU/page errors为空，两轮全部记录一致。

作者相机与box身份保持，实际WebGL读回1800×880的RGBA sum603932896、FNV32指纹1828514559前后相等。两轮before/fallback共4张dark1920×1080图均已查看：作者回退可见、box位置保持，Deep与Three亮度/helper显示差异沿用各自宿主；本门不认证跨renderer画质像素相等。宿主recreated仍是明确模拟，actualUnknownDriverFault=false，candidate destroyed为实际GPU刺激。runner已关闭Chrome/Vite并释放GPU，没有重复已验成功门。
