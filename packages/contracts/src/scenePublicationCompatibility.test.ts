import { describe, expect, it } from "vitest";
import { summarizeScenePublicationCompatibility, type PublicationCapabilityEvidence, type ScenePublicationCompatibilityInput } from "./scenePublicationCompatibility.js";

const capability = "deep.scene.static-primitives.v1";
function input(): ScenePublicationCompatibilityInput {
  return {
    target: "deep-native", sceneId: "scene-1", contentFingerprint: "a".repeat(64),
    compileGraphHash: "b".repeat(64), targetArtifactHash: "c".repeat(64), fixtureId: "fixture-1", platform: "windows-x64",
    profile: { version: "test-only-v1", capabilities: [capability] },
    items: [{ sceneId: "scene-1", objectId: "box-1", path: "primitives[0]", capability, status: "supported",
      reason: "测试夹具运行证据", remediation: "修改内容后重新验证", evidenceIds: ["proof-1"] }],
    evidence: [{ id: "proof-1", capability, target: "deep-native", sourceSemanticHash: "a".repeat(64),
      compileGraphHash: "b".repeat(64), targetArtifactHash: "c".repeat(64), scope: "native-window", fixtureId: "fixture-1", platform: "windows-x64" }],
  };
}

describe("scene publication compatibility summary", () => {
  it("retains full evidence bindings for the exact validated sample", () => {
    const source = input(), report = summarizeScenePublicationCompatibility(source);
    expect(report).toMatchObject({ schemaVersion: 1, status: "ready", capabilityProfileVersion: "test-only-v1",
      contentFingerprint: source.contentFingerprint, compileGraphHash: source.compileGraphHash,
      targetArtifactHash: source.targetArtifactHash, fixtureId: "fixture-1", platform: "windows-x64" });
    expect(report.items).toEqual(source.items);
    expect(report.items).not.toBe(source.items);
    expect(report.items[0]!.evidenceIds).not.toBe(source.items[0]!.evidenceIds);
    expect(report.evidence[0]).not.toBe(source.evidence[0]);
  });

  it("requires confirmation for proven degradation and preserves blocked reasons without evidence", () => {
    const source = input();
    expect(summarizeScenePublicationCompatibility({ ...source, items: [{ ...source.items[0]!, status: "degraded" }] }).status).toBe("confirmation-required");
    const blocked = { ...source.items[0]!, status: "blocked" as const, reason: "纹理资源缺失：pump.png", evidenceIds: [] };
    const report = summarizeScenePublicationCompatibility({ ...source, items: [blocked], evidence: [] });
    expect(report.status).toBe("blocked");
    expect(report.items[0]).toEqual(blocked);
  });

  it.each([
    ["scope", "static-render-packet"], ["scope", "web-runtime"], ["target", "three-webview"],
    ["sourceSemanticHash", "d".repeat(64)], ["compileGraphHash", "d".repeat(64)],
    ["targetArtifactHash", "d".repeat(64)], ["fixtureId", "different-fixture"],
    ["platform", "linux-x64"], ["capability", "deep.scene.static-glb.v1"],
  ])("rejects evidence with mismatched %s=%s", (key, value) => {
    const source = input();
    const proof = { ...source.evidence[0]!, [key]: value } as PublicationCapabilityEvidence;
    expect(summarizeScenePublicationCompatibility({ ...source, evidence: [proof] })).toMatchObject({ status: "blocked", items: [{ status: "blocked" }] });
  });

  it("rejects CPU-only evidence even when input declares the same CPU platform", () => {
    const source = input();
    expect(summarizeScenePublicationCompatibility({ ...source, platform: "cpu", evidence: [{ ...source.evidence[0]!, platform: "cpu", scope: "static-render-packet" }] }).status).toBe("blocked");
  });

  it("blocks unknown capabilities, foreign scene IDs and unknown statuses", () => {
    const source = input();
    for (const change of [{ capability: "unknown" }, { sceneId: "scene-2" }, { status: "future" }]) {
      const item = { ...source.items[0]!, ...change } as typeof source.items[number];
      expect(summarizeScenePublicationCompatibility({ ...source, items: [item] }).items[0]!.status).toBe("blocked");
    }
  });

  it("rejects missing, unresolved and duplicate evidence references", () => {
    const source = input();
    for (const evidenceIds of [[], ["missing"], ["proof-1", "proof-1"]]) {
      expect(summarizeScenePublicationCompatibility({ ...source, items: [{ ...source.items[0]!, evidenceIds }] }).status).toBe("blocked");
    }
    expect(summarizeScenePublicationCompatibility({ ...source, evidence: [...source.evidence, { ...source.evidence[0]! }] }).status).toBe("blocked");
  });

  it("blocks repeated checks but allows distinct capabilities on the same object", () => {
    const source = input();
    expect(summarizeScenePublicationCompatibility({ ...source, items: [...source.items, source.items[0]!] }).items.every((item) => item.status === "blocked")).toBe(true);
    const second = "deep.scene.camera.v1";
    expect(summarizeScenePublicationCompatibility({ ...source,
      profile: { ...source.profile, capabilities: [capability, second] },
      items: [...source.items, { ...source.items[0]!, capability: second, evidenceIds: ["proof-2"] }],
      evidence: [...source.evidence, { ...source.evidence[0]!, id: "proof-2", capability: second }],
    }).status).toBe("ready");
  });

  it("blocks WebView-only content on Native and requires Web runtime evidence for Three", () => {
    const source = input(), item = { ...source.items[0]!, status: "webview-only" as const };
    expect(summarizeScenePublicationCompatibility({ ...source, items: [item], evidence: [] }).status).toBe("blocked");
    expect(summarizeScenePublicationCompatibility({ ...source, target: "three-webview", items: [item] }).status).toBe("blocked");
    expect(summarizeScenePublicationCompatibility({ ...source, target: "three-webview", items: [item],
      evidence: [{ ...source.evidence[0]!, target: "three-webview", scope: "web-runtime" }],
    }).status).toBe("ready");
  });

  it("refuses empty checks, invalid hashes and ambiguous profiles instead of returning ready", () => {
    const source = input();
    for (const change of [{ items: [] }, { contentFingerprint: "" }, { fixtureId: " " },
      { profile: { version: "v1", capabilities: [capability, capability] } }]) {
      expect(() => summarizeScenePublicationCompatibility({ ...source, ...change })).toThrow(/上下文/);
    }
  });
});
