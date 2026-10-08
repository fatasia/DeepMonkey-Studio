import { describe, expect, it } from "vitest";
import { executedCapturePassIds } from "./pbrRendererFrameSupport.js";
import type { PbrRendererFrameHost } from "./pbrRendererFrames.js";
import { resolvePbrRendererFeatures } from "./pbrRendererFeatures.js";
import { resolvePbrPostProcessOverrides } from "./pbrPostProcessOverrides.js";

const features = resolvePbrRendererFeatures({ temporalAa: false, bloom: false });
const post = resolvePbrPostProcessOverrides(undefined, features);
function execution(contactResource: boolean, directClear = false, authorDirectDisplay = false) {
  const host = { features, ...(contactResource ? { contactShadows: {} } : {}) } as PbrRendererFrameHost;
  return executedCapturePassIds(host, directClear, post, true, false, authorDirectDisplay);
}

describe("production contact shadow execution receipt", () => {
  it("reports both real post-composite dispatches when the renderer owns contact resources", () => {
    const ids = execution(true);
    expect(ids.has("transparent-oit")).toBe(true);
    expect(ids.has("contact-shadow")).toBe(true);
    expect(ids.has("contact-apply")).toBe(true);
  });
  it("does not report execution from a feature bit without allocated resources", () => {
    const ids = execution(false);
    expect(features.contactShadows).toBe(true);
    expect(ids.has("contact-shadow")).toBe(false);
    expect(ids.has("contact-apply")).toBe(false);
  });
  it.each([[true, false], [false, true]])("preserves the actual direct path gate %s/%s", (directClear, authorDirectDisplay) => {
    const ids = execution(true, directClear, authorDirectDisplay);
    expect(ids.has("contact-shadow")).toBe(false);
    expect(ids.has("contact-apply")).toBe(false);
  });
});
