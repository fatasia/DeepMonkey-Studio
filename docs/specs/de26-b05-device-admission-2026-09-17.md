# DE26/B05：同设备候选准入

通过 `PbrRendererOptions.deviceMemoryBudgetBytes` 显式设置托管资源估算上限，传给 `DeviceSession.open`。
未配置时保留原行为；transient 独立默认上限继续有效。两种预算分层检查，统计不可相加。

## 行为

- 准入使用上一切片的唯一设备内存账本。新旧候选同时存活时同时计入，未知布局拒绝，不静默调整画质。
- 流式 buffer/texture uploader、mesh buffer、TextureResources、transient pool 均在同步 GPU create 前按 descriptor 预检。
  检查与 create/own 间没有 await，不引入 reservation 调度器。
- `own` 最终检查实际资源属性，超额/未知新资源销毁，旧所有权和正在编码的资源不变；重复 own 不重复收费。
- `resourceMemory.admission` 报告配置上限与拒绝次数。release/dispose 恢复容量；非法上限在请求 adapter 前拒绝。
- 原 stream 上传配额、latest-wins、取消、候选回滚继续由现有实现负责。

## 验证

六个聚焦文件 76 passed；WebGPU + streaming 150 文件 1171 passed / 22 skipped。
追加实际 `GpuResidencyRuntime` 组合回归 2 passed：流式预算 128 B、设备预算 64 B，已驻留粗层 32 B 时拒绝新 64 B，
GPU create 仍只有一次、旧句柄保留，dispose 归零。类型检查、lab build、runtime purity、repository gate 通过。

已添加实验室 `device-budget` 探针：20 B 独立设备预算，在旧目标编码后注入超额与未知格式请求，再提交读回并释放后重试。
本轮浏览器连接丢失，恢复检查返回无可用浏览器，探针尚未执行；该切片不记真实 GPU 通过，也不追加视觉评分。

## 承诺范围

这是同设备托管估算准入，不是物理 VRAM 硬上限。尚未迁移到 descriptor 前置入口的直接 create→own 路径
在创建后才检查，可能有短暂未托管候选；未知驱动对齐、CPU staging、未托管资源、跨设备候选不在此上限内。
这些路径的前置迁移、完整总预算策略和真实 GPU 新探针继续待办，B05 不标整卡完成。
