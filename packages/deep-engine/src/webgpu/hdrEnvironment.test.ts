import { describe, expect, it, vi } from "vitest";
import { createHdrEnvironment } from "./hdrEnvironment.js";

describe("HDR environment GPU boundary", () => {
  it("rejects a pre-aborted request before touching the device", async () => {
    const controller = new AbortController(), reason = new Error("cancelled by caller"); controller.abort(reason);
    const device = new Proxy({}, { get: vi.fn(() => { throw new Error("device touched"); }) });
    const session = { state: "ready", device };
    await expect(createHdrEnvironment(session as never,
      { width: 1, height: 1, data: new Float32Array([1, 1, 1]) }, {}, controller.signal)).rejects.toBe(reason);
  });

  it("fails invalid quality and pixel input before allocating resources", async () => {
    const device = new Proxy({}, { get: vi.fn(() => { throw new Error("device touched"); }) });
    const session = { state: "ready", device };
    await expect(createHdrEnvironment(session as never,
      { width: 1, height: 1, data: new Float32Array([1, 1, 1]) }, { specularSize: 32 as never }))
      .rejects.toThrow("quality");
    await expect(createHdrEnvironment(session as never,
      { width: 1, height: 1, data: new Float32Array([Number.NaN, 1, 1]) }))
      .rejects.toThrow("invalid radiance");
  });
});
