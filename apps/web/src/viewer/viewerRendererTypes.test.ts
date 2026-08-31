import { describe, expect, it } from "vitest";
import { normalizeRendererDeviceLoss } from "./viewerRendererTypes";

describe("normalizeRendererDeviceLoss", () => {
  it("keeps stable diagnostics from Three.js device loss details", () => {
    expect(normalizeRendererDeviceLoss({ message: "adapter reset", reason: "unknown" })).toEqual({
      api: "WebGPU",
      message: "adapter reset",
      reason: "unknown"
    });
  });

  it("provides a readable fallback for incomplete browser details", () => {
    expect(normalizeRendererDeviceLoss(undefined)).toEqual({
      api: "WebGPU",
      message: "GPU device was lost",
      reason: null
    });
  });
});
