# DE26/B05：设备托管分配报告

`DeviceSession.resourceMemory` 在现有 own/release 边界观察分配，`FrameMetrics.deviceResourceMemory` 返回冻结快照。
不新建 GPU 所有权或上传调度器；原 streaming 的每帧上传额度、transition headroom、latest-wins 与取消边界保持不变。

- buffer 使用 GPUBuffer.size；texture 按格式、mip、MSAA、array layer/3D depth 计算。压缩尾 mip 按块向上取整。
- 同一对象重复 own 不重复计数；新旧候选同时 owned 时同时计入峰值；取消/退休 release 立即减账。
- 无明确布局的格式与对象计入 unknownResources，不能作已覆盖字节；dispose 清零当前量、保留历史峰值。
- 全设备报告已包含 transient 和 shadow，禁止把这几项再次相加。

## 证据

16 项聚焦测试通过，覆盖数组与 3D mip、MSAA、BC/ETC/ASTC 块、非法尺寸、未知深度格式、重复 own、候选回收、dispose。
WebGPU 145 文件 1135 passed / 22 skipped；引擎 typecheck、lab build、runtime purity 与 repository gate 通过。

[真实 GPU 记录](de26-b05-device-memory-evidence-2026-09-17.json)：NVIDIA Lovelace 非 fallback，1180×825、49 球。
74 个托管对象中 unknown=0；buffer 8,728,836 B、texture 164,369,388 B、合计 173,098,224 B，
所有权峰值 173,357,496 B。池内 59,389,832 B 和定向阴影 67,108,864 B 已在设备纹理总量内。

## 剩余

这是格式估算，不是驱动 VRAM 查询；不含 tiling/内部对齐、未交由 session 托管的资源或 CPU staging。
统一总域预算强制执行、未托管 staging 清查、上传策略与跨设备候选峰值汇总仍属 B05 待办。
本轮无视觉设计变化；截图接口仍 unavailable，不追加视觉评分。local-spot-shadow-readback 既有探针失败独立保留。
