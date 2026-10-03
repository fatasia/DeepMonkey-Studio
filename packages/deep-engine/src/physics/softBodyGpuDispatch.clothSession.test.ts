import { describe, expect, it } from "vitest";
import { createClothGpuStepSession } from "./softBodyGpuDispatch.clothSession.js";
import { resetClothKernelSwitchTelemetry, snapshotClothKernelSwitchTelemetry } from "./softBodyGpuDispatch.clothParallel.js";
import type { ClothGpuStepInput } from "./clothGpuWgsl.js";

const input: ClothGpuStepInput = {
  particles: [
    { position: [0, 1, 0], inverseMass: 1, velocity: [0, 0, 0] },
    { position: [1, 1, 0], inverseMass: 1, velocity: [0, 0, 0] },
  ],
  constraints: [{ a: 0, b: 1, rest: 1 }],
  dtSeconds: 1 / 60, substeps: 8, compliance: 0, damping: 0.01,
  gravity: [0, -9.81, 0],
};

describe("ClothGpuStepSession 构建合同(CPU 侧;真机合同由 probe 承担)", () => {
  it("拒绝未知核选择", async () => {
    await expect(createClothGpuStepSession(
      {} as GPUDevice, input, { kernel: "auto" as never },
    )).rejects.toThrow(/kernel/);
    await expect(createClothGpuStepSession(
      {} as GPUDevice, input, { kernel: "cloth-gpu" as never },
    )).rejects.toThrow(/kernel/);
  });

  it("遥测口径:会话步进计数入口存在且快照形状稳定", () => {
    resetClothKernelSwitchTelemetry();
    const snapshot = snapshotClothKernelSwitchTelemetry();
    expect(snapshot.parallelSteps).toBe(0);
    expect(Object.keys(snapshot.fallbacksByReason).sort()).toEqual(
      ["coloring-unavailable", "gpu-error", "wgsl-compile-error"],
    );
  });
});
