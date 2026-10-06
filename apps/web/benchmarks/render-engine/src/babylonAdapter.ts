import type { BenchmarkEngineAdapter } from "./contracts";

/** Babylon WebGPU 档位。依赖 @babylonjs/core 已在 apps/web 锁定精确版本后启用;
 * WebGPU 不支持或依赖缺失时如实报不可用,不回退 WebGL、不伪造结果。 */
export const babylonWebGpuAdapter: BenchmarkEngineAdapter = {
  engine: "babylon-webgpu",
  available: true,
  async create(canvas, objectCount, startedAt, workload) {
    const { createBabylonWebgpuRuntime } = await import("./babylonWebgpuRuntime");
    return createBabylonWebgpuRuntime(canvas, objectCount, startedAt, workload);
  },
};

export function babylonAvailability(): { available: true; package: string } {
  return { available: true, package: "@babylonjs/core" };
}
