import { describe, expect, it } from "vitest";
import { TemporalValidityProvider, type TemporalValidityFrame } from "./temporalValidity.js";

const frame = (revision: number, changes: Partial<TemporalValidityFrame> = {}): TemporalValidityFrame => ({
  revision, width: 1920, height: 1080, cameraCut: false, motionAvailable: true, depthAvailable: true,
  materialRevision: 4, lightRevision: 7, exposure: 1, reactiveMaskAvailable: true, ...changes,
});

describe("TemporalValidityProvider", () => {
  it("publishes history only after commit and evaluates consumers independently", () => {
    const provider = new TemporalValidityProvider();
    const first = provider.beginFrame(frame(10));
    expect(first.decisions.taa.reasons).toContain("no-history");
    provider.cancelFrame(10);
    expect(provider.beginFrame(frame(10)).decisions.taa.reasons).toContain("no-history");
    provider.commitFrame(10);
    const stable = provider.beginFrame(frame(11));
    expect(stable.decisions.taa.valid).toBe(true);
    expect(stable.decisions.ddgi.valid).toBe(true);
    expect(stable.decisions["contact-shadow"].valid).toBe(true);
  });

  it("fails only the consumers whose material, light, exposure, or reactive inputs changed", () => {
    const provider = new TemporalValidityProvider();
    provider.beginFrame(frame(1)); provider.commitFrame(1);
    const changed = provider.beginFrame(frame(2, { materialRevision: 5, exposure: 2, reactiveMaskAvailable: false }));
    expect(changed.decisions.taa.reasons).toEqual(["exposure-change"]);
    expect(changed.decisions.ssr.reasons).toEqual(["material-change", "exposure-change"]);
    expect(changed.decisions.ddgi.reasons).toEqual(["material-change"]);
    expect(changed.decisions["volumetric-fog"].reasons).toEqual(["exposure-change"]);
    expect(changed.decisions["contact-shadow"].reasons).toEqual(["reactive-mask-unavailable"]);
  });

  it("invalidates screen-space histories on disocclusion while retaining world-space DDGI", () => {
    const provider = new TemporalValidityProvider();
    provider.beginFrame(frame(20)); provider.commitFrame(20);
    const plan = provider.beginFrame(frame(21, { disoccluded: true, cameraCut: true, width: 1280 }));
    expect(plan.decisions.taa.reasons).toContain("disocclusion");
    expect(plan.decisions.ssr.reasons).toContain("disocclusion");
    expect(plan.decisions["volumetric-fog"].reasons).toContain("disocclusion");
    expect(plan.decisions.ddgi.valid).toBe(true);
  });
});
