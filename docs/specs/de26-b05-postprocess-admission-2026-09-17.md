# B05：后处理与历史纹理预算准入

2026-09-17，承接 `3632213`。TAA、Bloom、AuthorBloom、AO、AOComposite 的纹理及参数缓冲全部复用 DeviceSession 分配前准入；不增加资源池或预算调度层。

预算拒绝沿现有候选回滚路径返回错误，保留先前输出和历史，不降低分辨率或关闭效果。池化候选先归还到当前帧 pending-return 队列，失败帧 `endFrame(false)` 再释放；不提前销毁可能已被编码引用的纹理。

新增测试用真实 `DeviceResourceMemory` 预算计算驱动 fake GPU 分配边界：

| 路径 | 预算 / 峰值 | 拒绝后结果 |
|---|---|---|
| TAA resize | 180 B / 176 B | 部分候选释放，旧 144 B 历史保留，下一帧继续使用历史 |
| Bloom resize | 900 B / 784 B | 部分金字塔释放，旧 528 B 输出保留，无新增 compute pass |
| 池化 Bloom | 100 B / 80 B | 第二张纹理创建前拒绝；失败帧清除候选，保留 16 B 可复用参数，dispose 后归零 |

验证：WebGPU + streaming + postprocess 共 160 个文件、1,266 项通过、28 项跳过；类型检查、lab 构建、runtime purity、repository governance 通过。Lab SHA-256：`85ccd9581f1548b8bca10f2592c5305e3cbf9b357c61ffbb82fa6f88b2c91d66`。

真实 GPU 准入探针仍待可用浏览器会话。本片测试证明预算与生命周期合同，不包含新的硬件读回或视觉验收。几何变形、粒子、GI、Hi-Z 等其他直接分配入口仍待迁移，不能据此宣称所有 GPU 分配已有分配前硬限制。
