# Deep Monkey Studio 对标引擎高价值场景分析（2026-09-19）

## 结论

假设当前八项任务全部完成，Deep Monkey Studio 在 BIM/工业数字孪生的离线交付、格式审计、跨端 Runtime Package 和工程数据语义上具备差异化优势；但要在“性能超越、效果对标”上成立，还缺少一组能把渲染器、场景编辑器和大规模数据运行时放在同一张基准表里的高价值场景。

本报告不建议追逐竞品全部功能。优先建设五类场景：大规模工业园区、复杂室内 BIM、动态工厂运行、地理空间/点云混合、程序化环境与数字人交互。每类场景必须同时记录画质、帧时间、显存、可见实例、首帧、流式峰值和故障恢复。

## 最新公开能力值得吸收的部分

| 对标 | 当前公开版本/方向 | 值得学的能力 | 对本项目的取舍 |
|---|---|---|---|
| Three.js | r186 为当前 releases 页面标记的 Latest；WebGPU/TSL 持续演进 | WebGPU 渲染后端、TSL 同时生成 WebGPU/WebGL 着色器、节点化后处理、轻量核心 | 学“后端可替换 + shader graph 可编译”，不复制 Three 全生态；保持现有 Runtime Package 和 Native 共用 ABI |
| Babylon.js | 9.0 | Frame Graph、Clustered Lighting、体积光、OpenPBR、Large World、3D Tiles、Gaussian Splat、SDF Text、Inspector v2 | Frame Graph、集群光照、大坐标和 3D Tiles 是高优先；Gaussian Splat 只作为混合场景可选层，不阻塞 BIM 主线 |
| Unity | Unity 6.x；官方 6.3 LTS 支持至 2027-12 | GPU Resident Drawer、GPU Occlusion Culling、Deferred+、DX12 Graphics Jobs、移动/多平台质量档 | 学“GPU 驻留 + GPU 遮挡 + 质量档自动切换”；以工业实例/构件语义做预算，不照搬 GameObject 生命周期 |
| Unreal | 5.7 已发布；5.8 的公开信息显示继续强化地形、植被、Lumen Lite 等方向 | Nanite/虚拟几何、Lumen、PCG Production-Ready、MegaLights、Substrate、Procedural Vegetation、Live Link | 学“虚拟几何 + 程序化环境 + 多光源分簇 + 低成本 GI”；不引入 UE/商业 SDK 依赖，采用自研/开源离线实现 |

版本依据： [Three.js 官方 releases（r186）](https://github.com/mrdoob/three.js/releases)、[Babylon.js 官方首页/特性页（9.0）](https://babylonjs.com/)、[Unity 6 官方新特性](https://docs.unity.com/en-us/engine/6000.7/manual/whats-new/unity6)、[Unity 6.3 LTS 支持页](https://unity.com/releases/unity-6/support)、[Unreal Engine 5.7 官方发布页](https://www.unrealengine.com/news/unreal-engine-5-7-is-now-available)。下一版本信息只作为公开方向信号，不把未发布功能写成验收承诺；验收以已发布版本和本地可复现实现为准。

## 当前假设完成后仍缺的高价值场景

### P0：必须补齐

1. **百万构件工业园区**：200–1000 个重复设备、建筑/管线/道路/围栏混合，支持园区→建筑→楼层→设备四级钻取、剖切、告警和飞线。关键是 GPU 驻留、实例化、遮挡剔除、LOD 和大坐标稳定性。
2. **复杂 BIM 室内楼层**：结构、机电、幕墙、透明材质、文字标注、剖切和测量同时出现；要证明跨端材质、阴影、文字和选择状态一致。
3. **动态工厂运行场景**：设备状态、传感器曲线、动画 TRS、交互事件、告警呼吸灯、数据绑定和回放。要把动态 Runtime Package 推进到 WebGPU/Native 同一帧驱动和确定性重放。
4. **GI/阴影/透明综合场景**：GI-on/off、阴影、反射、玻璃、后处理、文字同屏；当前 GI-off edge F1 差异说明这仍是硬缺口。

### P1：性能领先所需

5. **点云 + 3D Tiles + BIM 混合园区**：分块加载、空间索引、配准、LOD、回收、拾取和离线恢复；这是 Babylon 9.0 已明确强化的方向，也是工业 S3 的关键。
6. **程序化道路/绿化/围栏环境**：Nature Kit 和道路模板按样条、连接点、种子批量生成，支持撤销事务和实例化；对标 UE PCG，但输出必须进入现有场景状态和发布链。
7. **高光照设备车间**：数百动态灯、发光屏、体积雾、局部反射和告警灯；采用 Clustered Lighting/Frame Graph 思路，验证多灯场景的 GPU 优势。
8. **大坐标跨区域场景**：城市/厂区 GIS 坐标、浮点原点、相机飞行、阴影和测量一致性；对标 Babylon Large World，但优先保证 BIM 坐标与审计可追溯。

### P2：效果对标加分项

9. **数字人/机器人协同**：骨骼动画重定向、轨迹、碰撞和人体/机器人状态；只做工业任务闭环，不建设完整游戏角色系统。
10. **Gaussian Splat + BIM 叠加**：现场扫描作为背景层，BIM 构件作为可编辑层；必须明确拾取、深度、发布和离线边界。
11. **可视化材质实验室**：OpenPBR 参数、材质变体、纹理压缩和跨端快照；用于效果回归，不作为独立产品线。
12. **渲染管线编辑器**：受约束的 Frame Graph/Render Graph，提供 SSAO、Bloom、GI、阴影、透明排序的可审计 pass 图；禁止开放式 Shader Graph 失控扩张。

## 性能超越策略

不要用“同一模型平均 FPS”宣称超越。统一基准为：

| 层级 | 必测指标 |
|---|---|
| 首帧 | package hash、解析时间、首个可交互帧、峰值内存 |
| 稳态 | p50/p95/p99 GPU/CPU frame time、1% low、可见实例、draw/dispatch 数 |
| 资源 | 显存峰值、纹理/几何驻留、流式带宽、回收延迟 |
| 画质 | 几何/材质/透明/阴影/GI/文字/布局分项差异，不只看 SSIM |
| 恢复 | 设备丢失、断网、取消、重开、版本回滚后的可用时间和数据一致性 |

推荐实现顺序：

1. Frame Graph + GPU 资源预算/别名复用。
2. GPU 驻留、实例化、遮挡剔除和按语义分组的 LOD。
3. Clustered Lighting + 可降级 GI/阴影/透明管线。
4. Large World/Floating Origin 与点云/3D Tiles 空间调度。
5. 程序化场景和动态运行包的统一回放。

## 明确不追的方向

- 不复制 Three.js/Babylon.js 的全部插件生态。
- 不引入 Unreal/Unity 商业运行依赖或在线授权。
- 不用 Gaussian Splat、AI 助手或华丽后处理掩盖 BIM 几何/数据/发布缺陷。
- 不把单个 demo 的高 FPS 当成性能领先；必须绑定同资产、同机位、同质量和完整恢复证据。

## 下一组可执行验收包

- `BENCH-P0-01`：百万构件工业园区，WebGPU/Native 双端。
- `BENCH-P0-02`：复杂 BIM 室内，透明/剖切/文字/阴影。
- `BENCH-P0-03`：动态工厂回放，确定性帧驱动。
- `BENCH-P1-01`：GI-off/复杂几何矩阵，补齐当前 GI 缺口。
- `BENCH-P1-02`：点云 + 3D Tiles + BIM 混合园区。
- `BENCH-P1-03`：程序化道路/绿化/围栏与 Nature Kit 场景链。

这些场景应作为 D24–D28、工业 S3/S6、动态运行包和 V11 的共享基准，避免每个任务重新造夹具。
