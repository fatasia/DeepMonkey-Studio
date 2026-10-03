# I-C16 真实 CPU 路径积分核（2026-10-01）

## 现状核查

1. 全仓 packages/apps 源码与 git status 核查：已有 pathTraceSession、pathTraceSessionTypes 和 pathTraceReferenceKernel 接口；没有 traceSample 实现。未跟踪修改属于并行 I-C19/I-C23/J3/N10，保留。
2. 契约：contracts 无 PT 产品契约；复用 PathTraceReferenceKernel、PathTraceSceneIdentity、PathTraceProductSession 和 RadianceHdrImage，不新增平行状态机。
3. 依赖：deep-engine 已有 TypeScript/Vitest，无需运行依赖。
4. 消费方：PathTraceProductSession 仅导出，无产品调用；本切片增加实际 CPU 积分累积消费方。
5. 证据：已有 CPU 29 测及 RT/HDR 319 测。T10-implementation 为能力探测/命中语义证据，未证明相机路径积分。
6. 规格：已读 remaining-tasks-estimates-20260930、i-c16-pathtrace-product-cpu-20261001、主计划 T10 和 glm-handoff-20261001；标准漫反射收敛、材质失效、取消、静帧导出仍需真实样本链。

### 已有（不重建）

buildTracedScene/traceClosest、TLAS 底座、createReferenceRng、C3 ggxSpecularTimesCosine、PathTraceProductSession、encodeRadianceHdr/decodeRadianceHdr。

### 真实缺口

相机射线、Lambert/GGX 采样与 PDF、递归 throughput/Russian roulette、逐像素真实样本累积、实际 session/HDR 消费。

## 本切片边界

单 BLAS 静态三角形、逐三角 Lambert 或 GGX 导体材质及发光、pinhole 相机、常量或方向环境；真实多跳 CPU 核，固定 seed+像素+绝对样本序号可重放。GGX 评估复用 C3 CPU 公式；不宣称覆盖生产 PBR 全族。

CPU 消费方持有真实均值/二阶矩两平面，样本门按每像素 spp 计算，session 统计用各次全图均值；导出还要求每像素每通道相对标准误均满足同一阈值，使用 n−1 无偏方差。空间噪声抵消的全图假收敛负例已钉。材质/相机/场景身份变更显式重置并替换核，取消释放缓冲，真实像素编码 HDR。advanceAsync 注入调度器，逐完整样本交还事件循环并重查代际/取消。

TLAS 实例及 refit、纹理/透明/扩展 lobe、直接光重要性采样、MIS、降噪、worker/GPU、浏览器产品接线和视觉验收未覆盖。I-C16/T10 整项保持未关闭。

## 验证

已实测：

- Lambert 白炉逐样本等于 reflectance×environment；两次真实散射后命中发光面符合解析乘积。
- 16 个固定 seed 的 L=z² 漫反射解析目标 0.5：16 spp RMSE=0.0686974979371948，4096 spp RMSE=0.004898789262594115；门限 <0.01 且较16 spp下降至少4倍，实测下降14.02倍。
- GGX F0=1、alpha=1 法线视角白炉独立解析 ∫u/(u+1)du=1−ln2=0.3068528194400547；65536样本测得0.3075880635545704，绝对误差0.0007352441145156985 <0.005。四档粗糙度能量≤1.001；单散射GGX未补多次散射，粗糙白炉低于1符合边界。
- 固定 seed 重放、分批3+7+22与一次32样本像素逐位同；RR均值误差<0.015；输入数组快照防作者修改污染。
- 真实CPU像素→session→HDR→解码链、材质/相机/场景身份失效、预算拒绝、部分批取消、调度器取消、同步/异步旧代际拒发、空间噪声假收敛拒绝均通过。
- 聚焦新测试27例全绿；最终RT/HDR同族37文件346通过、1既有跳过；pnpm run typecheck（src/lab/examples三个tsconfig）通过；runtimePurityGate通过。
- 新源码/测试34–148行，均低于300行；包级 `packages/deep-engine/scripts/sourceSizeGate.mjs` 的门为301行（HEAD既有超限文件豁免），当前2个失败：`packages/deep-engine-native/tests/support/j3_window_events.rs` 497行、`packages/deep-engine-native/src/app/device_loss_probe_tests.rs` 428行；均属并行Native域，本刀未改。根级800行门不是本条执行的脚本。

原始证据：test-output/i-c16-cpu-reference-20261001/{vitest.txt,analytic-metrics.txt}。本切片零GPU/Cargo命令，无commit/push。未过产品视觉闭环，I-C16/T10保持子集交付。

## 接手入口

主包导出 `createPathTraceCpuKernel` 和 `PathTraceCpuRender`；用核options显式提供相机、单BLAS三角形和逐三角材质，再 `begin(identity,kernel)` → `advance`/`advanceAsync` → `exportHdr()`。取消/失效后 `image()` 不暴露旧像素。消费者不应直接用底层 `session.converged` 判定可导出，应用 `render.converged`（包含逐像素门）。

下一切片优先：复用 RenderPacketRayScene 适配生产场景及材质，缓存TLAS实例BLAS避免每条光线重建，再加入纹理/法线和直接光MIS；产品调度器/进度/取消/下载接线另验浏览器视觉闭环。当前没有产品侧调用和GPU/WGSL对拍，不把该CPU子集记作整项完成。

后继已推进正式静态RenderPacket/TLAS与相机子集、BLAS缓存和空实例order修复，见[后继适配报告](i-c16-render-packet-adapter-20261001.md)。上文单BLAS边界是本首片范围；生产材质全族与产品UI/GPU对拍仍未完成。
