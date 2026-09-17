# 完整 RuntimePackage 呈现后发布

完整热更新和文件拖放保留旧 renderer 的设备和场景资源，候选真正呈现后才发布 CPU 内容、资源快照和恢复检查点。相机、坐标原点及需要重建 renderer 的内容均走这一屏障。

## 窗口资源

RTX 4060/Vulkan 实验中，两个独立 renderer 同时配置同一窗口的 swapchain 导致测试子进程失败。正式实现预建两个未配置 surface，再释放旧 swapchain、配置候选 surface；候选失败时释放其 swapchain并重新激活旧 surface，调度旧场景重绘。设备、纹理、几何和 CPU 内容不随 surface 释放。不是跨设备交换 surface。

零尺寸窗口在分配候选 renderer 前延迟，100 ms 重试，连续版本只保留最新候选；非零尺寸的暂时不可呈现仍会在重试时重建候选，后续可优化其保留策略。构建和呈现失败不发布新版本。

## 验证

- 完整包、三维增量、实际 WGSL 更新三个 Windows GPU 用例通过；连续 generation 1/2 跳帧保留旧快照，恢复只发布 2。完整包测试同时断言零尺寸期间 renderer 代号不增加。
- 文件拖放真机用例完成目录包、manifest、普通包、预滤波 IBL 和相机包的连续替换；候选离屏校验后必须成功呈现才更新活动内容，缺失/非法候选保留旧内容。
- 坐标原点 GPU 测试完成新旧场景往返呈现，双方恢复后的 HDR 读回逐字节一致。零尺寸拒绝、候选 GPU callback 故障注入后旧内容重新呈现通过；640×480 HDR 原点对照沿用 1% 像素/0.1% 亮度阈值。
- bin 120 passed / 43 ignored，以上四个 GPU 用例另行显式执行；clippy tests、repository gate 通过。

本片未完成双轮截图视觉验收，未给视觉维度评分。未验证真实设备丢失期间的 surface 重建失败与所有 Windows 驱动；不据单个 Vulkan 设备证明跨后端矩阵。环境载荷专项、跨端矩阵仍待。
