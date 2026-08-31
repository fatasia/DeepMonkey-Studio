import { describe, expect, it, vi } from "vitest";
import { GpuResourceRetirementQueue } from "./gpuResourceRetirementQueue";

describe("GpuResourceRetirementQueue", () => {
  it("releases pending resources synchronously when the viewer is disposed", () => {
    const release = vi.fn();
    const queue = new GpuResourceRetirementQueue(() => undefined);

    queue.retire(release);
    queue.dispose();

    expect(release).toHaveBeenCalledOnce();
  });
});
