// F6/T18 软体并行核障碍刀:真机 WebGPU 探针(浏览器内执行,由 softBodyObstacleGpuTest.mjs 打包驱动)。
//
// 证据口径(如实声明,四列):
// A 公式级黄金:projectObstaclesSoftBody 单入口真机 dispatch(sphere/旋转 cuboid,障碍经
//   packSoftBodyGpuObstacles 64×80B ABI),读回 vs createSoftBodyStaticCollision f64 黄金
//   (同 f32 入态)逐点欧氏距离——纯 f32 量化,阈 1e-5(CPU 同口径实测 1e-7);
// B 动力学内核合同:GPU(有障碍) vs 色批序 f32 镜像(同编排)逐 24 tick ≤0.05 + 同 seed
//   双跑逐位(既有 runSoftBodyParallelGpuCheck 同口径);
// C 黄金对照列:GPU(有障碍) vs SoftBodySolver+contacts(每子步两次)f64 黄金,并跑
//   GPU(无障碍) vs 无 contacts 黄金对照列——两者之差 = 障碍核的边际效应。如实边界:
//   并行核(色批序)与串行黄金(构建序)在软 compliance 过约束系统上存在投影序相关平衡态
//   差异(无障碍基线 ~0.2,本探针同时量化),该差异先于障碍刀存在;
// D 接触可观测:GPU 有障碍 readback 自由粒子 min|dist−r| < 0.05(粒子贴障碍面)。
//
// uncapturederror 常驻监听(softbody-divergence-20261002 教训:Chrome 对绑定违约静默
// 丢弃命令缓冲,只有此通道可见)。
//
// sourceSizeGate 拆分(2026-10-03):按职责分文件,代码逐行同源仅改可见性,语义零变化;
// 本文件保留 runner 合同入口(probeAdapterInfo / gpuUncapturedErrors /
// runSoftBodyObstacleProjectionCheck / runObstaclePassVariantMatrix / runSoftBodyObstacleGpuReplay):
//   GPU 上下文/几何夹具 → softBodyObstacleGpuProbeShared.ts;
//   A+A2 投影对拍与变体矩阵 → softBodyObstacleGpuProbeProjection.ts;
//   B/C/D 动力学场景 → softBodyObstacleGpuProbeReplay.ts。
export { probeAdapterInfo, gpuUncapturedErrors } from "./softBodyObstacleGpuProbeShared.js";
export { runSoftBodyObstacleProjectionCheck, runObstaclePassVariantMatrix } from "./softBodyObstacleGpuProbeProjection.js";
export { runSoftBodyObstacleGpuReplay } from "./softBodyObstacleGpuProbeReplay.js";
