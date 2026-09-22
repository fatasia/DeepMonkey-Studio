# Deep GI、光追、探针与遮挡生产闭环审计（2026-09-22）

本报告只记录当前代码能证明的状态。`模块存在`、`实验探针通过`和`编辑器/正式产物已消费`分开计数，避免把底层原语当成产品能力。

## 权威缺口矩阵

| 能力 | 已有算法与资源 | Deep Web 正式消费者 | Deep Native 正式消费者 | 失效、恢复与诊断 | 当前结论 |
|---|---|---|---|---|---|
| 动态全局光照 | 探针 clipmap 规划、分帧更新、双缓冲体积、滤波、mip、PBR 采样、表面脏区和 relocation 均已存在 | Studio 可按作者 GI 开关创建 `DeepWebGpuProbeClipmapSession`；缺真实辐射生产者时保持原 IBL，不分配、不发布 fallback 体积 | 无探针体积与 PBR GI 消费链 | Web 保留最后成功体积、提交失败不覆盖、设备丢失清空；新增 requested/active/radianceSource/pending/packet revision/实例数/失败原因诊断 | **未完成**：生产没有 `encodeSourceRadiance`；已阻止黑色 fallback 冒充动态 GI |
| 多反弹 GI | 探针历史滞回可复用上一代体积 | 无真实一跳场景辐射输入，因此历史滤波不能证明多反弹 | 无 | 无 bounce 能量、收敛和泄漏诊断 | **未实现** |
| 光照探针闭环 | `ProbeClipmapRuntime`、capture executor、PBR controller、surface cache、relocation、纹理采样均有聚焦测试 | 已接正式 PBR；本轮消除 Studio 内外双控制器，并让空场景零分配 | 无 | 异步 supersede/cancel、最后成功态、设备丢失和可选诊断已有 | **部分闭环**：调度/资源/采样闭环，真实辐射捕获缺失 |
| RayBackend / 光追 | TS 有 BLAS/TLAS、软件 WGSL trace executor；新增 RenderPacket→既有 TLAS 适配与实例材质对齐；Native 有 CPU BVH/trace、RT 能力探测、真实 Ray Query probe 与驻留几何校验 | SSR 正式走屏幕空间；RayBackend 的探针遮挡、阴影扩展仍未进入帧图 | 渲染器未消费 `ray_backend`，硬件 RT 探测未形成画面路径；PlayerDiagnostics 对可用设备标为 `degraded/probe_only_renderer_raster` | RenderPacket 适配对 BLEND 排除、MASK 保守计数、deformation 无烘焙快照时失败关闭；无统一设备恢复产品回执 | **场景输入与独立硬件探针已补，正式光追画面路径仍未形成**；当前不能宣称硬件光追或光追 GI |
| 自动遮挡裁剪 | Web/Native 均已有上一帧 HiZ、实例判定、compact、间接绘制 | Web `PbrRenderer` 默认启用并消费上一帧金字塔，相机 cut 走保守失效 | Native 真管线默认 `auto` 挂载；显式 `DEEP_ENGINE_NATIVE_OCCLUSION_HIZ=off` 才关闭 | Web 有 scene/camera revision；Native 已加入主视锥变化后一帧 frustum-only 刷新，避免消费旧相机 HiZ；未知配置按 auto，保留显式回退 | **Web/Native 零配置启用且安全闭环已补；收益阈值遥测仍属最终校准** |

## 本轮完成的生产断点

Studio 之前同时创建两套 GI 控制器：`PbrRenderer` 由 `renderer.probeClipmap` 创建内部控制器，发布后 `DeepWebGpuBackend.setProbeClipmapEnabled` 又创建宿主控制器。两套控制器会重复创建管线、探针体积和异步更新。本轮把 Studio 收敛到宿主控制器，并保持独立 SDK 仍可显式选择 renderer-owned 控制器。

宿主控制器现在只有在“作者请求 GI 且 RenderPacket 至少含一个实例”时才实例化。场景清空会取消在途更新、释放控制器并清除 PBR binding；之后出现首个实例时按最新 packet revision 懒重建。关闭 GI 会清除迟到失败状态。`DeepWebGpuBackend.diagnostics.probeClipmap` 暴露请求态、活动态、在途态、包 revision、实例数和安全错误文本。

Studio 的生产宿主不再隐式使用常量 fallback。只有显式注入且运行时证明 `radianceSource=scene` 的控制器才激活探针；缺少生产者或仍返回 fallback 的宿主都会立即失败关闭，保持现有 IBL 且不发布探针。独立 SDK 的显式 fallback 验证入口保留。

Native HiZ 增加了时序安全门：主相机视锥字节变化时，本帧只消费 frustum 输出，跳过旧相机遮挡判定与 compact；提交后刷新 HiZ，静止的下一帧才恢复遮挡消费。该门同时阻断旧 compact 间接绘制和旧 readback 提交。

RayBackend 没有另建 BVH。新增的 `buildRenderPacketRayScene` 只负责把 RenderPacket 的共享几何、列主序实例变换和材质引用接到既有 `buildTlas`，并保持 GPU hit 的原始 instance index 与材质表同下标。BLEND 在缺 any-hit alpha continuation 时排除，MASK 以保守遮挡计数暴露；deformation 没有烘焙几何快照时整条路径失败关闭。

聚焦证据：

- `DeepWebGpuProbeClipmapSession.test.ts`：空场景零创建、首实例激活、清空释放、重新激活、在途取消、幂等释放、无真实辐射源失败关闭、伪装成宿主控制器的 fallback 拒绝发布。
- `StudioDeepWebGpuBridge.test.ts`：作者 GI 生命周期仍生效，Studio 创建参数不再同时启动 renderer-owned 控制器。
- `renderPacketRayScene.test.ts`：共享 BLAS、列主序变换、TLAS 命中到材质对齐、BLEND/MASK 语义和 deformation 失败关闭。
- Deep Engine 与 Web 类型检查通过；最新 GI 聚焦回归 3 个测试文件 25 项、Web 1 个测试文件 30 项通过；Native `cargo check --lib` 通过。

## 后续独立切片顺序

1. 给 probe capture 接真实场景辐射生产者：复用 RenderPacket 几何、材质、直接灯和环境，不再使用 fallback 辐射作为产品结果；先完成一跳并建立能量守恒、泄漏、动态脏区和设备恢复证据。
2. 在同一探针体积中引入受限历史反馈形成 2–4 次可配置多反弹，加入能量钳制、滞回重置、相机切换和动态发光体失效闭环。
3. 把既有 RayBackend 的探针遮挡扩展接入 capture 调度；软件 BVH 为通用路径，硬件 RT 只在能力探测和同画质验证通过后启用。
4. Native 复用相同探针 ABI与发布合同；没有真实辐射消费者前保持能力阻断，不用环境光冒充 GI。
5. Native HiZ 已改为零配置 auto 默认启用；显式 off 保留诊断回退，相机变化保守 bypass 已完成。收益阈值遥测仍在最终同设备基准阶段校准。
6. 完成同设备、同内容、同画质的最终基准与画面对拍，不用降低画质换性能结果。
