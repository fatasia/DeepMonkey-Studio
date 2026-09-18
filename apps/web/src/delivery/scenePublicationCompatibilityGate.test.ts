import { describe, expect, it } from "vitest";
import { summarizeScenePublicationCompatibility, type ScenePublicationCompatibilityReport } from "@bim-studio/contracts";
import { assertScenePublicationDeliverable, ScenePublicationCompatibilityError } from "./scenePublicationCompatibilityGate";

function report(): ScenePublicationCompatibilityReport {
  return summarizeScenePublicationCompatibility({ target: "deep-native", sceneId: "scene", contentFingerprint: "a".repeat(64),
    compileGraphHash: "b".repeat(64), targetArtifactHash: "c".repeat(64), fixtureId: "fixture", platform: "windows-x64",
    profile: { version: "fixture-v1", capabilities: ["static-mesh"] },
    items: [{ sceneId: "scene", objectId: "pump", path: "models[0]", capability: "static-mesh", status: "supported",
      reason: "真实窗口验证通过", remediation: "内容变化后重新检查", evidenceIds: ["proof"] }],
    evidence: [{ id: "proof", capability: "static-mesh", target: "deep-native", sourceSemanticHash: "a".repeat(64),
      compileGraphHash: "b".repeat(64), targetArtifactHash: "c".repeat(64), fixtureId: "fixture", platform: "windows-x64", scope: "native-window" }],
  });
}
function failure(source: ScenePublicationCompatibilityReport): ScenePublicationCompatibilityError {
  try { assertScenePublicationDeliverable(source); } catch (reason) {
    expect(reason).toBeInstanceOf(ScenePublicationCompatibilityError); return reason as ScenePublicationCompatibilityError;
  }
  throw new Error("Expected compatibility rejection");
}

describe("scene publication delivery gate", () => {
  it("accepts ready Native only with matching runtime evidence and does not mutate input", () => {
    const source = report(), before = structuredClone(source);
    expect(assertScenePublicationDeliverable(source)).toBeUndefined(); expect(source).toEqual(before);
  });

  it.each(["blocked", "degraded", "webview-only"] as const)("rejects ready summary concealing %s items", status => {
    const source = report();
    const error = failure({ ...source, items: [{ ...source.items[0]!, status, reason: "对象不支持", remediation: "换用已验证路径" }] });
    expect(error.code).toBe(status === "degraded" ? "publication-confirmation-required" : "publication-compatibility-blocked");
    expect(error.message).toContain("pump"); expect(error.message).toContain("models[0]");
    expect(error.message).toContain("对象不支持"); expect(error.message).toContain("换用已验证路径");
  });

  it.each(["blocked", "confirmation-required"] as const)("does not override explicit %s even with supported items", status => {
    const error = failure({ ...report(), status });
    expect(error.report.status).toBe(status);
    expect(error.code).toBe(status === "blocked" ? "publication-compatibility-blocked" : "publication-confirmation-required");
    if (status === "confirmation-required") expect(error.message).toContain("需审核降级方案后重新检查");
  });

  it.each([{ items: [] }, { schemaVersion: 2 }, { target: "unknown" }, { status: "unknown" }, { sceneId: "" },
    { contentFingerprint: "bad" }, { compileGraphHash: "bad" }, { targetArtifactHash: "bad" }, { fixtureId: "" },
    { platform: "" }, { capabilityProfileVersion: "" }])("rejects invalid report context %j", change => {
    expect(failure({ ...report(), ...change } as ScenePublicationCompatibilityReport).code).toBe("publication-compatibility-blocked");
  });

  it.each([{ scope: "static-render-packet" }, { fixtureId: "different" }, { sourceSemanticHash: "d".repeat(64) },
    { compileGraphHash: "d".repeat(64) }, { targetArtifactHash: "d".repeat(64) }])("revalidates supplied evidence %j", change => {
    const source = report(); const error = failure({ ...source, evidence: [{ ...source.evidence[0]!, ...change }] } as ScenePublicationCompatibilityReport);
    expect(error.report.items[0]?.status).toBe("blocked"); expect(error.message).toContain("运行证据");
  });

  it("accepts Three webview-only only with Web runtime evidence", () => {
    const source = report();
    const web: ScenePublicationCompatibilityReport = { ...source, target: "three-webview",
      items: [{ ...source.items[0]!, status: "webview-only" }],
      evidence: [{ ...source.evidence[0]!, target: "three-webview", scope: "web-runtime" }] };
    expect(() => assertScenePublicationDeliverable(web)).not.toThrow();
    expect(failure({ ...web, evidence: [] }).code).toBe("publication-compatibility-blocked");
  });

  it("bounds UI diagnostics but retains the complete immutable cloned report", () => {
    const source = report(); const blocked = { ...source, status: "blocked" as const,
      items: Array.from({ length: 11 }, (_, index) => ({ ...source.items[0]!, objectId: `object-${index}`, status: "blocked" as const,
        reason: `reason-${index}`, remediation: "修复对象" })) };
    const error = failure(blocked);
    expect(error.message).toContain("object-7"); expect(error.message).not.toContain("object-8");
    expect(error.message).toContain("另有 3 项"); expect(error.report.items).toHaveLength(11);
    expect(error.report).not.toBe(blocked); expect(error.report.items[0]).not.toBe(blocked.items[0]);
    expect(Object.isFrozen(error.report)).toBe(true); expect(Object.isFrozen(error.report.items)).toBe(true);
    expect(Object.isFrozen(error.report.items[0]!.evidenceIds)).toBe(true); expect(Object.isFrozen(error.report.evidence[0])).toBe(true);
    blocked.items[0]!.reason = "later mutation"; expect(error.report.items[0]!.reason).toBe("reason-0");
  });

  it("does not allow extra diagnostic or confirmation fields to bypass blocking", () => {
    const source = report();
    const candidate = { ...source, status: "confirmation-required" as const, allowDegraded: true, diagnosticOnly: true, confirmed: true };
    expect(failure(candidate).code).toBe("publication-confirmation-required");
    const blocked = { ...candidate, items: [{ ...source.items[0]!, status: "blocked" as const }] };
    expect(failure(blocked).code).toBe("publication-compatibility-blocked");
  });
});
