# P4 硬件光追能力合同

P4 只定义能力探测与降级决策，不启用 RT shader，也不改变现有光栅主路径。

`RayTracingCapabilities` 是可序列化快照：adapter、tier、三项 feature 和加速结构容量必须显式声明。决策顺序为 pipeline → ray-query → raster/software fallback；当能力不足时保持软件阴影、软件 GI 与光栅渲染，不产生半启用状态。

实现：`packages/deep-engine/src/rayTracingCapabilities.ts`。当前测试覆盖三档选择、非法 feature 拒绝和确定性降级。
