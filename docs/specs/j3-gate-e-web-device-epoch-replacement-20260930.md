# J3 Gate E：Web 完整设备资源图替换

DeviceSession 的恢复只保证新 device 和 Canvas context 就绪；PBR 管线、布局、绑定及帧附件属于旧 device，产品须创建完整候选宿主后再发布。

## 现状核查

1. 源码/未跟踪：全仓 packages/apps recovery/device epoch/rebuild 搜索与 git status 对账。已有 DeviceSession、PbrRenderer、DeepWebGpuBackend、StudioDeepWebGpuBridge；保留其他专线未跟踪源。PbrRenderer 的 readonly GPU owners 不能跨 device 使用。
2. 契约：DeviceRecoveryOptions、onDeviceRecreated/onFatalLoss、GPUDevice、RenderPacket/RenderView 与 StudioRendererSwitchResult 已存在；不增恢复平台或重定义作者输入。contracts 没有需要复制的类型。
3. 依赖：既有 Vitest、Three、WebGPU、Playwright、产品候选准备与 AbortSignal 足够，无新增依赖。
4. 消费：PbrRenderer 现 onDeviceRecreated → rebuildAfterRecovery → setPacketValidated，只替包未替 pipeline/frame/material布局等；recoveryError 赋值后没有读者。Bridge recreated 立即 renderDeepFrame，存在新device提交旧图风险。现 switchTo 已完整 create/upload/validate/publish，并用 generation/abort 丢弃迟到候选。
5. 测试/证据：已有 DeviceSession doubles 测恢复状态，Bridge生命周期测试覆盖取消/失败/迟到sync/资源退休；Native窗口实际destroyed重建及Web产品destroyed回退另外验收。没有真实unknown驱动故障可控来源；新增CPU回调模拟不作为该驱动故障实测。
6. 规格：对照窗口恢复现状规格、设备epoch首刀、J3 Gate E后继与权威剩余清单。修复旧资源图误复用，不重跑已通过深度/HDR/数学矩阵。I-C15六个probe shader/binding/env文件保持独占。

**已有（不重建）**：作者WebGL Canvas/场景/相机、唯一候选首帧验证发布事务、CPU包编译、loss分类/设备重开、generation/AbortSignal与迟到候选清理。

**真实缺口**：旧PBR graph当前能在DeviceSession换device后继续使用；局部“rehydrate”Promise可能无消费者reject。产品设备重开通知没有触发完整runtime替换。

## 候选替换及取消序列

1. PBR捕获创建device身份。render/validate、packet/resident/update、环境/阴影及创建GI/slot等GPU入口在GPU动作前拒绝跨device旧图。移除无效setPacket局部重建；正常同device路径保持。
2. Bridge只接受当前deepBackend发来的recreated。先记是否已有用户pending切换，再cancelPendingSwitch→publishWebGl；旧backend/订阅/Canvas立即退役、作者Canvas显示。
3. 已有用户pending切换时尊重该意图，不自动抢回。否则调用现switchTo(webgpu)完整candidate create/upload/validate/publish。
4. 新候选失败保持作者WebGL并一次报告；dispose、显式cancel或后续切换通过已有generation与AbortSignal取消，迟到candidate必须dispose。旧epoch重复通知因backend identity失效而忽略。
5. 新host再次loss走相同序列。destroyed仍fatal→WebGL；不将其reason改成unknown。

## 验收

先复现旧device图会继续触及GPU，再验证同device允许、跨device拒绝且零GPU触碰。CPU产品生命周期测试覆盖成功替换、失败、取消/dispose、用户已pending和旧epoch重复回调。真实GPU fresh device/upload/frame证据只证明资源重新创建；unknown驱动故障仍单列。视觉深色1920×1080，GPU/Cargo由主线串行。

## 已验证

修复前PBR入口9个跨device负例失败、1个同device对照通过；Bridge新增完整恢复/失败/取消/dispose/用户pending五例失败，原38例通过。日志`epoch-boundary-before.log`和`epoch-product-before.log`记录原行为。

修复后PBR相关5文件29测、Bridge43测、相邻环境/动画/灯光/网格生命周期4文件30测通过；追加probe绑定、probe工厂与cluster入口3个负例后共105测通过。core及web类型检查通过。PBR移除局部setPacket“重建”和未消费错误字段，constructor/factory捕获device归属，GPU入口在旧图触及新device之前拒绝。deviceEpoch可选访问只保持现prototype直调夹具兼容，生产constructor总是初始化该归属字段。

Bridge恢复回调同步退役旧图/订阅/Canvas，再复用既有候选完整事务。原默认destroyed真实产品回退门独立通过，恢复CPU测试是显式回调模拟。

独立追加门使用`node scripts/j3-device-epoch-replacement.mjs`：两轮真实Viewer/Bridge候选创建、上传和首帧验证，明确模拟当前宿主的recreated通知；要求立即WebGL保底、新device身份不同、旧session资源归零、作者相机/对象身份与WebGL逐字节指纹保留、重复旧回调拒绝。实际旧device的destroyed reason另行记录，不修改已有窗口入口或loss分类。结果目录为`test-output/interrupted-0930/epoch-replacement/`，本门只提供Web真实设备候选替换证据。

主线实际运行两fresh Chrome实例通过，`currentRun=true`只表示本次Web独立候选门。每轮真实GPU候选2个、device身份不同、旧session=disposed且资源0、新session=ready且资源85、Deep Canvas恰1；旧宿主重复通知没有第三候选，fatal/failure/GPU errors均0。实际旧device退休后lost.reason=destroyed。作者相机、box身份、WebGL读回1800×880完全保留：RGBA sum603932896、FNV32指纹1828514559。两轮全部记录相同，已查看4张dark1920×1080的before/replacement截图，box可见、位置及材料显示稳定。

日志为`test-output/interrupted-0930/j3-epoch-candidate-run.log`，源哈希与逐轮结果在`epoch-replacement/evidence.json`。通知刺激仍是`synthetic-recreated-notification`，`actualUnknownDriverFault=false`；该结果认证不同真实GPU设备上的完整产品候选替换，不认证真实unknown驱动故障、驱动显存或恢复耗时。失败候选的GPU后继使用独立新入口，本次已验源冻结。
