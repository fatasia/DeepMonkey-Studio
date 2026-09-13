import { describe, expect, it, vi } from "vitest";
import { createPbrEnvironment } from "./pbrEnvironmentSource.js";

describe("PBR environment source", () => {
  it("rejects invalid and pre-aborted sources before touching the GPU", async () => {
    const session = new Proxy({}, { get: vi.fn(() => { throw new Error("GPU touched"); }) });
    await expect(createPbrEnvironment(session as never, { kind: "unknown" } as never,
      new AbortController().signal)).rejects.toThrow("Unknown");

    const controller = new AbortController(), reason = new Error("cancelled");
    controller.abort(reason);
    await expect(createPbrEnvironment(session as never, { kind: "studio" }, controller.signal))
      .rejects.toBe(reason);
  });

  it("validates Radiance images through the HDR path before device allocation", async () => {
    const device = new Proxy({}, { get: vi.fn(() => { throw new Error("GPU touched"); }) });
    const session = { state: "ready", device };
    await expect(createPbrEnvironment(session as never, {
      kind: "radiance-hdr", image: { width: 1, height: 1,
        data: new Float32Array([Number.NaN, 1, 1]) },
    }, new AbortController().signal)).rejects.toThrow("invalid radiance");
  });
});
