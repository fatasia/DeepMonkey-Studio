import { describe, expect, it } from "vitest";
import { buildPbrFrameExecutionPlan } from "../webgpu/pbrFramePlanExecutor.js";
import { resolvePbrRendererFeatures } from "../webgpu/pbrRendererFeatures.js";
import { PBR_TIMED_PASS_IDS } from "../webgpu/pbrTimedPassIds.js";
import { contactShadowOptionsForQuality, CONTACT_SHADOW_QUALITY_PROFILES,
  estimateContactShadowMaskBytes, resolveContactShadowQuality } from "./contactShadowQuality.js";
import { contactShadowWgsl, CONTACT_SHADOW_UNIFORM_BYTES } from "./contactShadowWgsl.js";
import { describeContactShadowPass } from "./contactShadowResources.js";
import { packContactShadowUniform, surfaceToLightView } from "./contactShadowUniform.js";

describe("contact shadow quality tiers", () => {
  it("exposes the three-tier vocabulary with bounded step counts", () => {
    for (const tier of ["performance", "balanced", "quality"] as const) {
      const options = contactShadowOptionsForQuality(tier);
      expect(options.steps).toBeGreaterThanOrEqual(2);
      expect(options.strength).toBeGreaterThan(0);
      expect(options.strength).toBeLessThanOrEqual(1);
    }
    expect(contactShadowOptionsForQuality("quality").steps)
      .toBeGreaterThan(contactShadowOptionsForQuality("performance").steps);
  });

  it("rejects unknown tiers at the wiring boundary (probeClipmap contract style)", () => {
    expect(() => contactShadowOptionsForQuality("ultra" as never)).toThrow(RangeError);
    expect(() => resolveContactShadowQuality("invalid" as never)).toThrow(RangeError);
  });

  it("profiles are frozen and ordered performance < balanced < quality by steps", () => {
    expect(CONTACT_SHADOW_QUALITY_PROFILES.performance.options.steps)
      .toBeLessThan(CONTACT_SHADOW_QUALITY_PROFILES.balanced.options.steps);
    expect(CONTACT_SHADOW_QUALITY_PROFILES.balanced.options.steps)
      .toBeLessThan(CONTACT_SHADOW_QUALITY_PROFILES.quality.options.steps);
  });

  it("estimates half-resolution r16float mask bytes and validates inputs", () => {
    expect(estimateContactShadowMaskBytes(192, 192)).toBe(96 * 96 * 8);
    expect(() => estimateContactShadowMaskBytes(0, 8)).toThrow(RangeError);
  });
});

describe("contact shadow resources contract", () => {
  it("packs the 24-float uniform in the WGSL ContactParams order", () => {
    const viewProjection = Array.from({ length: 16 }, (_, index) => index);
    const data = packContactShadowUniform({ projection: viewProjection as unknown as Float32Array<ArrayBuffer>,
      lightView: [0.25, 0.5, 0.75, 0.5], thickness: 0.04, strength: 0.7, falloff: 1, radius: 0.35,
      width: 192, height: 192 });
    expect(data.length).toBe(CONTACT_SHADOW_UNIFORM_BYTES / 4);
    expect([...data.slice(0, 16)]).toEqual(viewProjection);
    const lightView = [...data.slice(16, 20)];
    lightView.forEach((value, index) => expect(value).toBeCloseTo([0.25, 0.5, 0.75, 0.5][index]!, 6));
    const tuning = [...data.slice(20, 24)];
    tuning.forEach((value, index) => expect(value).toBeCloseTo([0.04, 0.7, 1, 0.35][index]!, 6));
    expect([...data.slice(24)]).toEqual([192, 192, 96, 96]);
    expect(() => packContactShadowUniform({ projection: Float32Array.from([0]), lightView: [0, 0, 1, 1],
      thickness: 1, strength: 1, falloff: 1, radius: 1, width: 1, height: 1 })).toThrow(RangeError);
  });

  it("transforms the world ray direction into a view-space surface-to-light unit vector", () => {
    const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    expect([...surfaceToLightView([0, -1, 0], identity)]).toEqual([0, 1, 0]);
    const rotated = [0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]; // world x → view -y
    expect([...surfaceToLightView([0, 0, -1], rotated)][2]).toBe(1);
    expect(() => surfaceToLightView([0, 0, 0], identity)).toThrow(RangeError);
  });

  it("injects the tier step count as a kernel constant and validates the range", () => {
    expect(contactShadowWgsl(10)).toContain("step <= 10u");
    expect(contactShadowWgsl(10)).not.toContain("CONTACT_STEPS");
    expect(() => contactShadowWgsl(1)).toThrow(RangeError);
    expect(() => contactShadowWgsl(65)).toThrow(RangeError);
  });

  it("declares the plan contract: previous-frame depth in, half-resolution mask out", () => {
    const description = describeContactShadowPass();
    expect(description.passId).toBe("contact-shadow");
    expect(description.reads).toEqual(["linear-depth"]);
    expect(description.writes).toEqual(["contact-shadow-mask"]);
    expect(description.gpuPassCount).toBe(1);
  });
});

describe("contact shadow frame plan", () => {
  const SURFACE = { width: 320, height: 200 };
  const features = resolvePbrRendererFeatures({ contactShadows: true });

  it("orders the contact trace+apply after opaque and before the present", () => {
    const plan = buildPbrFrameExecutionPlan(SURFACE, { transparency: false, features });
    const traceIndex = plan.passOrder.indexOf("contact-shadow");
    const opaqueIndex = plan.passOrder.indexOf("opaque");
    const applyIndex = plan.passOrder.indexOf("contact-apply");
    expect(traceIndex).toBeGreaterThan(opaqueIndex);
    expect(applyIndex).toBeGreaterThan(traceIndex);
    const presentIndex = plan.passOrder.indexOf("present");
    expect(applyIndex).toBeLessThan(presentIndex);
    expect(plan.passes.find(pass => pass.passId === "contact-apply")?.reads).toContain("contact-shadow-mask");
  });

  it("keeps the pass inside the timed registry so F1 per-pass GPU timing can bracket it", () => {
    const plan = buildPbrFrameExecutionPlan(SURFACE, { transparency: false, features });
    expect(plan.mappedPassIds).toContain("contact-shadow");
    expect(PBR_TIMED_PASS_IDS).toContain("contact-shadow");
  });

  it("is absent from the plan when the opt-in feature is off (Z 默认档不带)", () => {
    const plan = buildPbrFrameExecutionPlan(SURFACE,
      { transparency: false, features: resolvePbrRendererFeatures({}) });
    expect(plan.passOrder).not.toContain("contact-shadow");
    expect(PBR_TIMED_PASS_IDS).toContain("contact-shadow");
  });
});
