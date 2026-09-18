import type { BenchmarkEngineAdapter } from "./contracts";

/** Babylon is intentionally reported as unavailable until the workspace pins a Babylon build.
 * Keeping this adapter explicit prevents silently comparing different fixtures or dependency versions. */
export const babylonWebGpuAdapter: BenchmarkEngineAdapter = {
  engine: "babylon-webgpu",
  available: false,
  reason: "未检测到工作区锁定的 Babylon.js 依赖；未擅自引入依赖或伪造基准结果",
  async create() {
    throw new Error(this.reason);
  },
};

export function babylonAvailability(): { available: false; reason: string } {
  return { available: false, reason: babylonWebGpuAdapter.reason! };
}
