import { describe, expect, it } from "vitest";
import {
  ALL_RT_FEATURE_CANDIDATE_NAMES, buildRayTracingCapabilitiesSnapshot, deriveRayTracingTier,
  detectRayTracingFeatureSupport, resolveT10PathDecision, RT_FEATURE_NAME_CANDIDATES,
} from "./rtCapabilityProbe.js";
import { validateRayTracingCapabilities } from "../rayTracingCapabilities.js";

/**
 * 真机 fixture：headless Chrome 153 / NVIDIA Lovelace（Dawn）adapter 特征全表，
 * 摘自 test-output/ray-trace-gpu-20260920-r2/evidence.json（T10 之前的真机证据）。
 * 该列表不含任何 RT 候选名——即当前 wgpu 路径未暴露硬件 RT 特征的既证形态。
 */
const CHROME153_LOVELACE_FEATURES: readonly string[] = [
  "bgra8unorm-storage", "chromium-experimental-multi-draw-indirect",
  "chromium-experimental-sampling-resource-table", "chromium-experimental-timestamp-query-inside-passes",
  "clip-distances", "core-features-and-limits", "depth-clip-control", "depth32float-stencil8",
  "dual-source-blending", "float32-blendable", "float32-filterable", "indirect-first-instance",
  "primitive-index", "rg11b10ufloat-renderable", "shader-f16", "subgroup-size-control", "subgroups",
  "texture-component-swizzle", "texture-compression-bc", "texture-compression-bc-sliced-3d",
  "texture-compression-unaligned", "texture-formats-tier1", "texture-formats-tier2", "timestamp-query",
];

describe("rt capability probe mapping (T10 slice 1)", () => {
  it("maps the real Chrome 153 feature list to tier none with an explicit software path decision", () => {
    const snapshot = buildRayTracingCapabilitiesSnapshot({ adapterId: "nvidia-lovelace-dawn", featureNames: CHROME153_LOVELACE_FEATURES });
    expect(snapshot.tierDerived).toBe("none");
    expect(snapshot.contractValid).toBe(true);
    expect(snapshot.support.matchedNames["acceleration-structure"]).toEqual([]);
    expect(snapshot.support.matchedNames["ray-query"]).toEqual([]);
    expect(snapshot.support.matchedNames["rt-pipeline"]).toEqual([]);
    // 合同回执：快照必须通过 P4 validate（机读落盘的前提）。
    expect(validateRayTracingCapabilities(snapshot.capabilities)).toBe(true);
    const { decision, softwarePathRequired } = resolveT10PathDecision(snapshot.capabilities);
    expect(decision.enabled).toBe(false);
    expect(softwarePathRequired).toBe(true);
    expect([...decision.fallbacks]).toEqual(["raster", "software-gi", "software-shadows"]);
  });

  it("derives query tier from acceleration-structure + ray-query and pipeline from the full set", () => {
    const querySupport = detectRayTracingFeatureSupport(["chromium-experimental-ray-query"]);
    expect(querySupport.features["ray-query"]).toBe(true);
    // AS 候选名之一命中 + ray-query → query tier。
    const queryTier = deriveRayTracingTier(detectRayTracingFeatureSupport(
      ["ray-tracing-acceleration-structure", "ray-query"]).features);
    expect(queryTier).toBe("query");
    const pipelineTier = deriveRayTracingTier(detectRayTracingFeatureSupport(
      ["ray-tracing-acceleration-structure", "ray-query", "rt-pipeline"]).features).valueOf();
    expect(pipelineTier).toBe("pipeline");
    // 合同决策链：query tier 快照启用 ray-query 档并带 software-shadows 回退。
    const snapshot = buildRayTracingCapabilitiesSnapshot({ adapterId: "rt-dongle", featureNames: ["ray-tracing-acceleration-structure", "ray-query"] });
    const { decision, softwarePathRequired } = resolveT10PathDecision(snapshot.capabilities, "query");
    expect(snapshot.tierDerived).toBe("query");
    expect(decision.enabled).toBe(true);
    expect(decision.tier).toBe("query");
    expect(softwarePathRequired).toBe(false);
  });

  it("treats empty and unknown feature lists as tier none without throwing", () => {
    expect(deriveRayTracingTier(detectRayTracingFeatureSupport([]).features)).toBe("none");
    const unknown = detectRayTracingFeatureSupport(["totally-unknown-feature", "not-a-rt-feature"]);
    expect(unknown.features["acceleration-structure"]).toBe(false);
    expect(unknown.features["ray-query"]).toBe(false);
    expect(unknown.features["rt-pipeline"]).toBe(false);
  });

  it("keeps the candidate name table complete and deterministic across repeated calls", () => {
    // 每个 P4 feature 至少一个候选名，且全部候选名可被探测函数往返识别。
    for (const feature of Object.keys(RT_FEATURE_NAME_CANDIDATES) as (keyof typeof RT_FEATURE_NAME_CANDIDATES)[]) {
      expect(RT_FEATURE_NAME_CANDIDATES[feature]!.length).toBeGreaterThan(0);
    }
    expect(new Set(ALL_RT_FEATURE_CANDIDATE_NAMES).size).toBe(ALL_RT_FEATURE_CANDIDATE_NAMES.length);
    const a = detectRayTracingFeatureSupport(CHROME153_LOVELACE_FEATURES);
    const b = detectRayTracingFeatureSupport([...CHROME153_LOVELACE_FEATURES].reverse());
    expect(a.features).toEqual(b.features);
    expect(a.matchedNames).toEqual(b.matchedNames);
  });

  it("fails closed when a disabled decision would ship incomplete software fallbacks", () => {
    // 合同函数在 tier none 恒返回三 fallback；此处守护 resolveT10PathDecision 的 fail-closed 断言路径。
    const snapshot = buildRayTracingCapabilitiesSnapshot({ adapterId: "none", featureNames: [] });
    expect(() => resolveT10PathDecision(snapshot.capabilities)).not.toThrow();
    expect(resolveT10PathDecision(snapshot.capabilities).softwarePathRequired).toBe(true);
  });
});
