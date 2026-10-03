// T18 A3 并行布料:真机 WebGPU 重放探针(浏览器内执行,由 clothParallelGpuTest.mjs 打包驱动)。
//
// 证据口径(如实声明):
// - 本探针把 wgsl/clothSolver.wgsl(单源)编译为真实 GPU pipeline,按合同 dispatch 序
//   (每子步 integrate → 逐色 project → finalize+kinetics)重放 240 ticks,逐 24 tick
//   读回状态与 CPU f32 模拟镜像(clothParallelSolver.ts)对拍;
// - 逐位成立 = 真机浮点实现与模拟口径一致;不一致时输出逐步最大漂移,并对照
//   f64 黄金(ClothSolver)0.05 m 容差与 5% 拉伸带给出容差口径结论;
// - 同 seed 真机双跑逐位(GPU 重放确定性)独立成列。
//
// sourceSizeGate 拆分(2026-10-03):按职责分文件,代码逐行同源仅改可见性,语义零变化;
// 本文件保留 runner 合同入口(probeAdapterInfo / runClothParallelGpuReplay /
// runClothParallelGpuProductionReplay / runSoftBodyParallelGpuCheck / gpuUncapturedErrors):
//   场景常量/指纹度量/GPU 上下文 → clothParallelGpuProbeShared.ts;
//   240 tick 主证据重放 → clothParallelGpuProbeReplay.ts;
//   生产换核入口复验 → clothParallelGpuProbeProduction.ts;
//   软体并行核复验 → clothParallelGpuProbeSoftbody.ts。
export { probeAdapterInfo, gpuUncapturedErrors } from "./clothParallelGpuProbeShared.js";
export { runClothParallelGpuReplay } from "./clothParallelGpuProbeReplay.js";
export { runClothParallelGpuProductionReplay } from "./clothParallelGpuProbeProduction.js";
export { runSoftBodyParallelGpuCheck } from "./clothParallelGpuProbeSoftbody.js";
