import { describe, expect, it } from "vitest";
import {
  RENDERER_CAPABILITY_MANIFEST,
  type RendererCapabilityManifestEntry,
} from "@bim-studio/contracts";
import {
  buildEngineCapabilityMatrix,
  buildFormatCapabilityRows,
  buildRendererCapabilityDomains,
  capabilityStatusCell,
  rendererCapabilityCounts,
  rendererCapabilityDomainId,
} from "./engineCapabilityMatrixModel";

function entry(id: string, webSupport: RendererCapabilityManifestEntry["web"]["support"] = "supported",
  nativeSupport: RendererCapabilityManifestEntry["web"]["support"] = webSupport,
  webReason: RendererCapabilityManifestEntry["web"]["reason"] = "full",
  nativeReason: RendererCapabilityManifestEntry["web"]["reason"] = "full"): RendererCapabilityManifestEntry {
  return {
    id, title: id, webFeatureKeys: [],
    web: { support: webSupport, reason: webReason, evidence: "packages/deep-engine/src/webgpu/x.ts:SYMBOL" },
    native: { support: nativeSupport, reason: nativeReason, evidence: "packages/deep-engine-native/src/x.rs:SYMBOL" },
  };
}

describe("capabilityStatusCell", () => {
  it("maps all nine legal support+reason pairs to public labels and tones", () => {
    expect(capabilityStatusCell({ support: "supported", reason: "full", evidence: "a.ts" })).toMatchObject({ label: "完整可用", tone: "ok" });
    expect(capabilityStatusCell({ support: "supported", reason: "opt-in-default-off", evidence: "a.ts" })).toMatchObject({ label: "可用 · 需开启", tone: "optin" });
    expect(capabilityStatusCell({ support: "supported", reason: "harness-only", evidence: "a.ts" })).toMatchObject({ label: "验收通路", tone: "neutral" });
    expect(capabilityStatusCell({ support: "degraded", reason: "reduced-tier", evidence: "a.ts" })).toMatchObject({ label: "降级", tone: "warn" });
    expect(capabilityStatusCell({ support: "degraded", reason: "opt-in-default-off", evidence: "a.ts" })).toMatchObject({ label: "降级 · 需开启", tone: "warn" });
    expect(capabilityStatusCell({ support: "degraded", reason: "harness-only", evidence: "a.ts" })).toMatchObject({ label: "降级 · 验收通路", tone: "warn" });
    expect(capabilityStatusCell({ support: "unavailable", reason: "absent", evidence: "a.ts" })).toMatchObject({ label: "规划中", tone: "planned" });
    expect(capabilityStatusCell({ support: "unavailable", reason: "api-missing", evidence: "a.ts" })).toMatchObject({ label: "依赖平台 API", tone: "blocked" });
    expect(capabilityStatusCell({ support: "unavailable", reason: "host-specific", evidence: "a.ts" })).toMatchObject({ label: "宿主专属", tone: "neutral" });
  });

  it("derives the displayable evidence path by stripping symbol and note suffixes", () => {
    const cell = capabilityStatusCell({ support: "supported", reason: "full", evidence: "packages/deep-engine/src/webgpu/materialBindings.ts:MATERIAL_PARAMETER_FLOATS(48 float=192B 唯一打包实现)" });
    expect(cell.evidencePath).toBe("packages/deep-engine/src/webgpu/materialBindings.ts");
  });

  it("falls back to the support vocabulary for unknown pairings instead of throwing", () => {
    const cell = capabilityStatusCell({ support: "supported", reason: "absent", evidence: "a.ts" });
    expect(cell.tone).toBe("neutral");
    expect(cell.label).toBe("完整");
  });
});

describe("rendererCapabilityDomainId", () => {
  it("classifies the known manifest ids into the public domains", () => {
    expect(rendererCapabilityDomainId("sdf-gi")).toBe("gi");
    expect(rendererCapabilityDomainId("gi-probe-directions")).toBe("gi");
    expect(rendererCapabilityDomainId("megalights")).toBe("gi");
    expect(rendererCapabilityDomainId("shadow-cascades")).toBe("shadows");
    expect(rendererCapabilityDomainId("contact-shadows")).toBe("shadows");
    expect(rendererCapabilityDomainId("local-shadow-abi-16")).toBe("shadows");
    expect(rendererCapabilityDomainId("hardware-ray-query")).toBe("ray-tracing");
    expect(rendererCapabilityDomainId("ray-traced-shadows")).toBe("ray-tracing");
    expect(rendererCapabilityDomainId("deep2d-visual-trio")).toBe("deep-2d");
    expect(rendererCapabilityDomainId("taa")).toBe("post-fx");
    expect(rendererCapabilityDomainId("virtual-geometry")).toBe("large-scene");
    expect(rendererCapabilityDomainId("material-abi-192b")).toBe("materials");
    expect(rendererCapabilityDomainId("device-recovery-bridge")).toBe("device");
    expect(rendererCapabilityDomainId("something-new")).toBe("other");
  });

  it("covers every registered manifest id with a non-other domain or an honest fallback", () => {
    const unclassified = RENDERER_CAPABILITY_MANIFEST
      .map(capability => capability.id)
      .filter(id => rendererCapabilityDomainId(id) === "other");
    // 登记表当前面不允许静默落"其他":新 id 必须显式归域或在此处更新断言。
    expect(unclassified).toEqual([]);
  });
});

describe("buildRendererCapabilityDomains", () => {
  it("groups rows by domain in the declared presentation order", () => {
    const domains = buildRendererCapabilityDomains([
      entry("taa"), entry("sdf-gi"), entry("hardware-ray-query"), entry("deep2d-visual-trio"),
    ]);
    expect(domains.map(domain => domain.id)).toEqual(["gi", "ray-tracing", "deep-2d", "post-fx"]);
    expect(domains[0]!.rows.map(row => row.id)).toEqual(["sdf-gi"]);
    expect(domains[0]!.title).toBe("全局光照(GI)");
  });

  it("returns empty domains for an empty manifest (page-level empty state)", () => {
    expect(buildRendererCapabilityDomains([])).toEqual([]);
    expect(rendererCapabilityCounts([])).toEqual({ total: 0, bothSupported: 0, limited: 0, planned: 0 });
  });

  it("keeps both end declarations per row with evidence passthrough", () => {
    const domains = buildRendererCapabilityDomains([entry("sdf-gi", "degraded", "unavailable", "reduced-tier", "absent")]);
    expect(domains[0]!.rows[0]!.web).toMatchObject({ support: "degraded", tone: "warn" });
    expect(domains[0]!.rows[0]!.native).toMatchObject({ support: "unavailable", label: "规划中", tone: "planned" });
    expect(domains[0]!.rows[0]!.native.evidencePath).toBe("packages/deep-engine-native/src/x.rs");
  });
});

describe("rendererCapabilityCounts", () => {
  it("splits totals into both-supported / limited / planned", () => {
    const counts = rendererCapabilityCounts([
      entry("a", "supported", "supported"),
      entry("b", "supported", "degraded", "full", "reduced-tier"),
      entry("c", "supported", "unavailable", "full", "absent"),
    ]);
    expect(counts).toEqual({ total: 3, bothSupported: 1, limited: 1, planned: 1 });
  });
});

describe("buildFormatCapabilityRows", () => {
  it("maps format statuses to public labels with evidence references", () => {
    const rows = buildFormatCapabilityRows([
      {
        id: "gltf", label: "glTF / GLB", extensions: ["gltf", "glb"], family: "runtime-scene",
        direction: "both", scope: "core", implementationStatus: "implemented",
        runtimeStatus: "available", validationStatus: "production-validated",
        fidelityTargets: [], validatedFidelity: {},
        validationEvidence: [{ id: "e1", kind: "fixture", reference: "test-output/gltf-e2e.md", checkedAt: "2026-09-26" }],
        decisionReason: "主交付格式",
      },
      { id: "x3d", label: "X3D", extensions: ["x3d"], family: "runtime-scene", direction: "import", scope: "core",
        implementationStatus: "planned", runtimeStatus: "unavailable", validationStatus: "unverified",
        fidelityTargets: [], validatedFidelity: {}, validationEvidence: [], decisionReason: "规划" },
      { id: "dwg", label: "DWG", extensions: ["dwg"], family: "precise-cad", direction: "import", scope: "excluded",
        implementationStatus: "excluded", runtimeStatus: "not-applicable", validationStatus: "not-applicable",
        fidelityTargets: [], validatedFidelity: {}, validationEvidence: [], decisionReason: "明确不支持" },
    ]);
    expect(rows[0]).toMatchObject({ statusLabel: "生产可用", tone: "ok", directionLabel: "导入/导出", scopeLabel: "内置" });
    expect(rows[0]!.evidenceRefs).toEqual(["test-output/gltf-e2e.md"]);
    expect(rows[1]).toMatchObject({ statusLabel: "规划中", tone: "planned", evidenceRefs: [] });
    expect(rows[2]).toMatchObject({ statusLabel: "不支持", tone: "blocked" });
  });
});

describe("buildEngineCapabilityMatrix", () => {
  it("derives the whole page from the two contract registries without hand-copied rows", () => {
    const matrix = buildEngineCapabilityMatrix();
    expect(matrix.renderer.counts.total).toBe(RENDERER_CAPABILITY_MANIFEST.length);
    expect(matrix.renderer.domains.length).toBeGreaterThan(0);
    const domainRowIds = matrix.renderer.domains.flatMap(domain => domain.rows.map(row => row.id)).sort();
    expect(domainRowIds).toEqual(RENDERER_CAPABILITY_MANIFEST.map(capability => capability.id).sort());
    expect(matrix.formats.rows.length).toBeGreaterThan(0);
    expect(matrix.formats.productionReady).toBeLessThanOrEqual(matrix.formats.rows.length);
  });
});
