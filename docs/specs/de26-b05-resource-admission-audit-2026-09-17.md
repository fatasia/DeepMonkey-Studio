# B05 剩余分配入口与硬件验证状态

审计基线 `540d503`，2026-09-17。可复现命令：在 `packages/deep-engine` 运行 `node scripts/auditResourceAdmission.mjs`。结果清单见同名 JSON；仅识别直接成员调用，不证明动态别名、驱动缓存或外部分配已经覆盖。

## 分配边界

当前生产源码共 44 处直接创建调用：2 处为已预准入 gateway；38 处先创建再登记所有权，其中 37 处为 buffer/texture、1 处为 QuerySet；另 4 处由独立 owner 持有，不进入 DeviceSession 内存计量。

- 优先迁移 `gpuFrustumCulling.ts` 的共享 storage 工厂：`packetCulling.ts` 和 `authorSelectedLodResources.ts` 均通过裸 device 创建该 context。实例输入、前帧矩阵、bounds 与 phase 输出均走局部 owned 数组，当前会话指标不包括它们。
- `deep2d/gpu.ts` 的 atlas、MSAA 和顶点 buffer 由 `renderDeep2dGpuFrame` 局部持有；`dashboardCompositionHost.ts` 传入的是 `session.device`，现有会话指标也不包括它们。
- 其余迁移按几何/变形/粒子、Hi-Z/meshlet、GI/cluster、fallback/辅助读回分组。已有 `create → own` 最终拒绝不能替代分配前准入。
- `GpuTimer` 的 QuerySet 没有可靠大小估计。启用显式 device budget 后再打开 GPU 诊断，会明确拒绝该 unknown 资源；不能把诊断场景记为预算兼容。默认计时关闭。禁止填写伪造大小或静默取消画质作为修复。

## 真实 GPU 状态

实验室 `http://127.0.0.1:5291/` 保持监听，PID 26904；manifest 返回 HTTP 200，构建 SHA-256 `85ccd9581f1548b8bca10f2592c5305e3cbf9b357c61ffbb82fa6f88b2c91d66`。工具检索只有当前 Node browser runtime，没有另一套可用浏览器通道。子线程及主线程打开页面都返回 queued；随后再次查询浏览器列表仍为 `[]`。

`deviceBudgetProbe` 的真实拒绝、旧已编码纹理读回、20 B 峰值与释放后重试均未执行。待浏览器恢复后运行实验室能力验证并保存新报告，检查 `device-budget.success`、RGBA `[51,102,153,255]`、峰值 20 B、未知格式拒绝、释放归零以及 build SHA 一致；旧计量报告不能替代这些项目。

本片仅新增审计工具与证据。工具自身 2 项测试通过；生产单测未重复运行。
