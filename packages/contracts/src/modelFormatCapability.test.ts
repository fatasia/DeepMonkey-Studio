import { describe, expect, it } from "vitest";
import { findModelFormatCapability, MODEL_FORMAT_CAPABILITY_CATALOG } from "./modelFormatCatalog.js";
import {
  isModelFormatProductionReady,
  validateModelFormatCapability,
  type ModelFormatCapability
} from "./modelFormatCapability.js";

describe("model format capability contract", () => {
  it("covers the high-value neutral format families without claiming runtime support", () => {
    for (const extension of ["glb", "step", "ifc", "usd", "dxf", "dwg", "fbx"]) {
      const capability = findModelFormatCapability(extension);
      expect(capability, extension).toBeDefined();
      expect(capability?.scope, extension).toBe("core");
      expect(capability?.runtimeStatus, extension).toBe("unavailable");
      expect(capability?.validationStatus, extension).toBe("unverified");
      expect(isModelFormatProductionReady(capability!), extension).toBe(false);
    }
  });

  it("records bounded runtime facts for builtin jt and x_t chains without production readiness", () => {
    for (const extension of ["jt", "x_t"]) {
      const capability = findModelFormatCapability(extension);
      expect(capability, extension).toBeDefined();
      expect(capability?.implementationStatus, extension).toBe("implemented");
      expect(capability?.runtimeStatus, extension).toBe("degraded");
      expect(capability?.validationStatus, extension).toBe("fixture-validated");
      expect(capability?.runtimeFacts?.qualityTier, extension).toBe("visual-complete");
      expect(capability?.runtimeFacts?.losses.length, extension).toBeGreaterThan(0);
      expect(capability?.validationEvidence.length, extension).toBeGreaterThan(0);
      // 受控子集不等于生产可用：仍缺 production-validated 与全维保真证据。
      expect(isModelFormatProductionReady(capability!), extension).toBe(false);
      expect(MODEL_FORMAT_CAPABILITY_CATALOG.flatMap(validateModelFormatCapability)).toEqual([]);
    }
    expect(findModelFormatCapability("jt")?.runtimeFacts?.losses).toContain("geometry.uv");
    expect(findModelFormatCapability("x_t")?.runtimeFacts?.notes.join("\n")).toContain("generic-parser");
  });

  it("normalizes dotted and uppercase extensions", () => {
    expect(findModelFormatCapability(".JT")?.id).toBe("jt");
    expect(findModelFormatCapability(" GLB ")?.id).toBe("gltf");
    expect(findModelFormatCapability(".X_T")?.id).toBe("parasolid");
  });

  it("keeps excluded long-tail formats explicit and non-runnable", () => {
    for (const extension of ["sldprt", "catpart", "nwd", "dgn", "hsf", "xvl", "pdf"]) {
      const capability = findModelFormatCapability(extension);
      expect(capability?.scope, extension).toBe("excluded");
      expect(capability?.implementationStatus, extension).toBe("excluded");
      expect(capability?.runtimeStatus, extension).toBe("not-applicable");
      expect(capability?.validationStatus, extension).toBe("not-applicable");
      expect(isModelFormatProductionReady(capability!), extension).toBe(false);
    }
  });

  it("has unique ids and extensions and passes catalog validation", () => {
    const ids = MODEL_FORMAT_CAPABILITY_CATALOG.map((item) => item.id);
    const extensions = MODEL_FORMAT_CAPABILITY_CATALOG.flatMap((item) => item.extensions);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(extensions).size).toBe(extensions.length);
    expect(MODEL_FORMAT_CAPABILITY_CATALOG.flatMap(validateModelFormatCapability)).toEqual([]);
  });

  it("requires runtime, production evidence, and required fidelity before readiness", () => {
    const base: ModelFormatCapability = {
      id: "sample", label: "Sample", extensions: ["sample"], family: "precise-cad", direction: "import", scope: "core",
      implementationStatus: "implemented", runtimeStatus: "available", validationStatus: "production-validated",
      fidelityTargets: [
        { dimension: "visual-geometry", minimum: "full", required: true },
        { dimension: "pmi", minimum: "partial", required: false }
      ],
      validatedFidelity: { "visual-geometry": "partial" },
      validationEvidence: [{ id: "evidence-1", kind: "production-sample", reference: "reports/sample.json", checkedAt: "2026-08-31T00:00:00.000Z" }],
      decisionReason: "用于合同门禁测试"
    };

    expect(isModelFormatProductionReady(base)).toBe(false);
    expect(isModelFormatProductionReady({
      ...base,
      validatedFidelity: { "visual-geometry": "full" }
    })).toBe(true);
    expect(validateModelFormatCapability({ ...base, validationEvidence: [] })).toContain("生产验证必须提供可追溯证据");
  });
});
