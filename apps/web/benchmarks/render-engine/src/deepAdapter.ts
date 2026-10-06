import type { BenchmarkEngineAdapter } from "./contracts";

/** Deep WebGPU 档位:产品自研引擎经 three-bridge 投影渲染同一 fixture。
 * WebGPU 缺席时由运行时如实抛错,不回退 WebGL、不伪造结果。 */
export const deepWebGpuAdapter: BenchmarkEngineAdapter = {
  engine: "deep-webgpu",
  available: true,
  async create(canvas, objectCount, startedAt, workload) {
    const { createDeepWebgpuRuntime } = await import("./deepWebgpuRuntime");
    return createDeepWebgpuRuntime(canvas, objectCount, startedAt, workload);
  },
};
