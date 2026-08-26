# iTwin Studio 与 Unity 渲染性能基准

## 目标与结论口径

目标不是证明某一方“总是更快”，而是回答三个可复现的问题：

1. 相同浏览器场景下，iTwin Studio WebGPU 相对 WebGL 2 的收益、退化和兼容性是什么。
2. 相同资产、相机、分辨率和画质下，iTwin Studio 本地渲染与 Unity Release Player 的性能差异是什么。
3. 相同 GPU、编码器、码率和网络条件下，iTwin Studio 云渲染与 Unity Render Streaming 的端到端差异是什么。

不生成单一综合分。每个工作负载分别报告帧时间、资源消耗、延迟和画质，结论必须带硬件、驱动、
浏览器/Unity/代码版本、场景哈希、配置与原始结果。

## 当前基线环境

- Windows 11，Intel Core i9-12900HX，31.8 GB RAM。
- NVIDIA GeForce RTX 4060 Laptop GPU，8188 MiB，驱动 595.79。
- Unity Hub 3.12.1 已安装，但本机当前未发现 Unity Editor；Unity 对照组尚不能构建。
- iTwin Studio 已能在同一场景内切换 WebGPU 实验后端并回退 WebGL 2。
- 云渲染当前只有 `RemoteRenderSession` 协议与状态机，没有 GPU Worker、编码器、WebRTC 媒体和输入链路，
  因而当前不存在可测试的云渲染结果，也不得宣称优于 Unity。

2026-08-25 的空场景浏览器烟测在同一会话各读取 5 次编辑器内置 FPS：WebGPU 为
`138 / 136 / 137 / 113 / 136`，WebGL 2 为 `138 / 138 / 140 / 114 / 136`。该结果只证明两种后端都能
初始化、切换和持续渲染；空场景、采样过短且未锁定功耗/刷新率，**不能用于性能排名**。

## 公平性控制

| 变量 | 固定方式 |
|---|---|
| 资产 | 同一 GLB/KTX2/纹理和内容哈希；不让 Unity 使用专有源资产优化 |
| 场景 | 同一对象、三角面、材质、灯光、动画、碰撞体和可见性 |
| 相机 | 同一位置、目标、FOV、near/far 和 120 秒确定性轨迹 |
| 分辨率 | 1920×1080、2560×1440、3840×2160，渲染比例 100% |
| 画质 | 阴影、AA、环境、后处理、纹理过滤、LOD 和遮挡逐项映射并截图核对 |
| 运行形态 | iTwin Studio 生产构建；Unity Windows x64 Release Player，不测 Unity Editor |
| 系统 | 同一机器、同一显示模式、接通电源、固定性能档、关闭覆盖层和无关后台任务 |
| 采样 | 30 秒预热、120 秒采样、每项 5 次；报告中位数及最差一次，不挑最好结果 |

## 固定工作负载

| ID | 内容 | 目的 |
|---|---|---|
| R0 | 空场景与编辑器 UI | 启动、后端切换和框架开销烟测 |
| R1 | 100 万三角面、100 材质、静态园区/通用空间 | 基础提交与材质成本 |
| R2 | 500 万三角面、500 材质、LOD/遮挡/实例 | 中型数字孪生主场景 |
| R3 | 1000 万三角面、1000 材质、楼层分解与透明 | 重型场景和显存压力 |
| R4 | 200 AGV/运动对象、物流路径、实时数据更新 | CPU 更新、动画和数据桥 |
| R5 | 第一人称碰撞、物理、粒子和后处理 | 交互与复杂运行时 |

工业综合案例完成后冻结为 `R-industrial-v1`；另保留不含行业语义的通用层级场景，防止基准只适用于工厂。

## 本地渲染指标

- 首次可交互时间、场景切换 P50/P95、着色器/管线预热时间。
- 平均 FPS；P1 与 P0.1 FPS；平均、P50、P95、P99 和最大帧时间。
- CPU 主线程、渲染线程、GPU 帧时间；Draw Call、三角面、管线/材质切换。
- 进程内存、JS/托管堆、GPU 专用显存、峰值与 20 次层级切换后的残留。
- 输入到下一帧呈现延迟；第一人称碰撞扫描耗时与卡顿帧数量。
- 固定相机截图的 SSIM/像素差和人工画质评审。画质不等价的结果不直接比较 FPS。

浏览器端使用 `requestAnimationFrame` 帧序列、Long Task、User Timing、Chrome trace 和可用时的 WebGPU
timestamp query；Unity 使用 `FrameTimingManager`/ProfilerRecorder 的 CPU/GPU 帧时间，并用外部 ETW/NVIDIA
工具交叉验证。Unity 官方说明 FrameTimingManager 自身会产生观测开销，因此正式排名以无 Profiler 的外部采样
为主，内置数据用于定位瓶颈。

## 云渲染对照

iTwin Studio 和 Unity 都必须在相同 RTX 4060/同级云 GPU、同一场景与相机轨迹下运行，并固定：

- H.264 硬件编码器、1080p60 / 1440p60 / 4K30、相同码率、GOP 和色彩格式。
- 相同浏览器、同一台客户端、同一 LAN；再分别注入 20/50/100 ms RTT、0/1/3% 丢包和带宽限制。
- 同一 STUN/TURN 路径；分别记录直连与 TURN 中继，禁止一方直连、另一方中继。

指标分解为 `input → server receive → simulation → render → encode → network → decode → present`，至少记录：

- 输入到显示 P50/P95/P99；首帧和重连时间。
- 服务端渲染、编码时间；客户端抖动缓冲和解码时间。
- 实际码率、丢包、重传、冻结帧、分辨率降级、PSNR/SSIM/VMAF。
- 每 GPU 并发会话、显存/编码器占用、单会话成本和故障回收时间。

Unity Render Streaming 官方资料说明分辨率、码率、网络状态和硬件/软件编码器会显著影响结果，因此这些变量
必须固定；只有完整 GPU Worker 与 WebRTC 链路通过故障隔离后，iTwin Studio 才能进入这组对比。

## 判定门槛

- WebGPU 成为默认：R1–R5 中至少 4 项的 P95 帧时间比 WebGL 2 改善 15% 以上，剩余项不得退化超过 5%，
  画质门槛通过且浏览器/GPU 发布矩阵满足要求；否则继续保持实验并自动回退 WebGL 2。
- “本地性能超过 Unity”只能限定到具体工作负载、画质和硬件；要求 P95 帧时间、峰值显存和首帧至少两项更优，
  另一项不差于 5%，并公开不占优的场景。
- “云渲染超过 Unity”要求同网络矩阵下输入到显示 P95 至少改善 10%，冻结帧率和画质不差，且每 GPU 并发/成本
  至少一项更优；任何一项只在降低画质或码率后获胜，不算超过。

## 依据

- Unity FrameTimingManager：https://docs.unity3d.com/cn/6000.0/ScriptReference/FrameTimingManager.html
- Unity FrameTiming：https://docs.unity3d.com/cn/6000.0/ScriptReference/FrameTiming.html
- Unity Render Streaming：https://docs.unity3d.com/ja/Packages/com.unity.renderstreaming%403.1/manual/index.html
- Unity 视频流参数：https://github.com/Unity-Technologies/UnityRenderStreaming/blob/main/com.unity.renderstreaming/Documentation~/video-streaming.md
- WebGPU Candidate Recommendation Draft：https://www.w3.org/TR/2026/CRD-webgpu-20260109/
