import { describe, expect, it, vi } from "vitest";
import { gpuValidatedStage } from "./gpuValidatedStage.js";

function fixture() {
  const pending: Array<(value: GPUError | null) => void> = [];
  const device = { pushErrorScope: vi.fn(), popErrorScope: vi.fn(() =>
    new Promise<GPUError | null>(resolve => pending.push(resolve))) } as unknown as GPUDevice;
  return { device, pending };
}

describe("gpuValidatedStage", () => {
  it("closes every scope before awaiting and reports a scoped error", async () => {
    const f = fixture(), value = {};
    const result = gpuValidatedStage(f.device, () => value, "candidate failed");
    expect(result.value).toBe(value);
    expect(f.device.pushErrorScope).toHaveBeenCalledTimes(3);
    expect(f.device.popErrorScope).toHaveBeenCalledTimes(3);
    f.pending[0]!(null); f.pending[1]!({ message: "oom" } as GPUError); f.pending[2]!(null);
    await expect(result.checked).rejects.toThrow("candidate failed: oom");
  });

  it("pops opened scopes and preserves the synchronous staging failure", () => {
    const device = { pushErrorScope: vi.fn()
      .mockImplementationOnce(() => {}).mockImplementationOnce(() => { throw new Error("scope push"); }),
    popErrorScope: vi.fn(() => Promise.reject(new Error("scope pop"))) } as unknown as GPUDevice;
    expect(() => gpuValidatedStage(device, () => 1, "failed")).toThrow("scope push");
    expect(device.popErrorScope).toHaveBeenCalledOnce();
  });
});
