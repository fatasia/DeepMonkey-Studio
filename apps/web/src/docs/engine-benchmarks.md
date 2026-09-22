# 引擎性能与画质基准

本页是 Deep Engine 最终基准报告在现有文档中心的固定入口。正式对手只有 Three.js、Babylon.js、Unity、Bevy 0.19。UE 与 Godot 不参与正式基准、排名或能力分母。

## 当前结论状态

最终跨引擎运行仍在进行，尚未形成最终胜出结论。现有单元测试、局部 CPU 数据、Native 冒烟、截图或不同负载下的历史数字只能证明相应模块工作，不能证明整体超过其他引擎。完成最终实测后，本页会写入冻结环境、原始证据路径、逐场景结果和可复跑命令。

## 比较对象

- **Three.js**：浏览器作者基线，在相同浏览器、WebGPU/WebGL 轨道、资产、相机、分辨率和质量设置下成对运行。
- **Babylon.js**：浏览器 WebGPU 对手，使用冻结版本和相同内容、可见性、效果与交互脚本。
- **Unity**：使用本机已安装版本生成独立 Player；记录渲染 API、质量配置、构建身份和实际图形设备。
- **Bevy 0.19**：固定 Native wgpu 轨道，在项目外隔离 Cargo 缓存与构建目录，不改项目依赖和系统 PATH。

## 冻结条件

每个场景保存操作系统、CPU、GPU、驱动、供电模式、物理分辨率、运行时版本、构建哈希、资产 SHA-256、相机轨迹、随机种子、可见性、动态状态和全部画质设置。Deep 与参考引擎至少交替运行五组成对轮次，防止缓存、温度和运行顺序偏置。

报告同时记录 CPU 与 GPU P50/P95/P99、整帧 P99、输入延迟、冷启动、加载到可交互、30 分钟长稳 P99、主机内存、显存、设备恢复和冻结画面相似度。只有 GPU timestamp 才写作 GPU 时间；host wall time 会明确标注。

## 画质与能力门槛

性能结果必须建立在同内容、同画质、同可见性和同交互功能上。关闭阴影、降低分辨率、减少对象、改用静态截图或删除不利 case 都会使结果无效。关键能力未实现、未接线或未验证时保留在分母中，不用其他领域得分抵消。

对 Bevy 0.19 还要求 Native wgpu、完整 CPU/GPU P50/P95/P99、加载、输入、内存、长稳和画质相似度；缺任一必需指标即拒绝结论。Unity、Three.js、Babylon.js 分别发布独立结果，不用最好的一项代表全部对手。

## 证据与复跑入口

### Bevy 0.19 配对切片（未形成胜负结论）

2026-09-22 已完成 5 轮交替的 Deep/Bevy `factory-instances/cubes-v2` 配对采样，双方均为 RTX 4060 Laptop、Vulkan、1280×720。证据保存在 [`test-output/bevy-019-benchmark/paired-evidence.json`，runner、Cargo 缓存和构建物均在工作区外隔离目录。当前证据显示 Deep 主机峰值约 196.7 MB、Bevy 约 361.2 MB；Deep 专用显存约 513.0 MB、Bevy 约 544.1 MB。Deep CPU/GPU 尾延迟在该夹具上仍有快慢混合，不能据此宣称胜出。

证据仍为 `incomplete / eligible=false`：缺少生产输入延迟、Deep 冷启动与加载到可交互、30 分钟长稳和同视角画质相似度。缺项补齐前，页面只展示原始采样，不生成排名或“超过”结论。

可执行合同位于 `packages/deep-engine/src/benchmarkContract.ts` 与 `benchmarkTargetMatrix.ts`。浏览器基准入口为：

```bash
pnpm --filter @bim-studio/web benchmark:render-engines
pnpm --filter @bim-studio/deep-engine lab:serve
```

独立 SDK 门禁、Unity Player 与 Bevy 隔离 runner 的最终命令会在各自完成后补入本节。原始 JSON、截图、视频、日志和环境清单写入 `test-output/`，报告只引用与当前构建哈希一致的证据。

## 如何阅读最终结果

最终结果按场景逐项展示 Deep 与对手的中位数、尾延迟、资源峰值和画质差异，并标明置信范围、失败恢复和已知限制。“超过”只用于冻结场景和明确指标，不外推为复制对手全部生态或在所有硬件上领先。

引擎结构与外部接入参见 [Deep Engine 独立 SDK](deep-engine-sdk)，设计来源参见 [引擎借鉴与设计理念](engine-design-influences)。
