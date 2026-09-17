# B05：视锥剔除资源进入会话预算

2026-09-17。修复 `8df87f2` 审计发现的生产漏计：`PacketCullingResources` 与 `AuthorSelectedLodResources` 向共享剔除 context 传入 DeviceSession；输入、上一帧矩阵、bounds、参数及每视图 compacted/frustum/counter/indirect buffer 均在分配前准入，统一登记和释放。

`createGpuCullingPipelineContext(device, session?)` 保留裸 device 调用方式。提供 session 时要求同一 device；不提供时仍由独立 context 持有，因此审计工具中的直接裸 device 分支不是全局已覆盖的证明。

Author LOD 的 CPU owner 不再作为未知 GPU 资源登记，实际 buffer 独立计量。会话先释放后再销毁 context 不重计、不重复 destroy。

预算拒绝时只释放未发布候选，保留旧 packet 的共享输入和 phase；失败帧的 active draw 仍清空，避免把旧绘制误当成新数据。后续用旧数据重试复用原 buffer。非预算 GPU 故障保留原有失效清理规则。

## 证据

专属 `cullingBudget.test.ts` 5 项覆盖：

- 200 B 预算：部分共享输入达到 192 B 后拒绝，释放归零。
- 64 实例 packet：9 个 buffer 共 25,736 B。扩容到 128 实例或更换 phase 被拒绝，临时 buffer 释放，旧 buffer 身份保持，重试不再创建。
- Author LOD 两套几何：18 个 buffer 共 1,072 B，unknown=0；1,300 B 预算下候选峰值 1,296 B 后拒绝，原有输入保留。
- 会话与 context 交错释放只 destroy 一次。

完整 WebGPU + streaming + postprocess：161 个文件、1,271 项通过、28 项跳过；类型检查、lab 构建、runtime purity、repository governance 通过。Lab SHA-256：`330a74cff3fa6a27abcddb38c59a5935fa35d02182f1d1fc382b2e09cf2b7b24`。

本片未运行新的真实 GPU 探针。Deep2D 及其余 late-own 分配入口不在本片范围内；没有变更共享台账。
