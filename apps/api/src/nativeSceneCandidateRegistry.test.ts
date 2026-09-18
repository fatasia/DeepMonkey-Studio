import { expect, it } from "vitest";
import { summarizeScenePublicationCompatibility, type PublicationCapabilityEvidence } from "@bim-studio/contracts";
import { createNativeSceneCandidateRegistry, type NativeScenePublicationCandidate } from "./nativeSceneCandidateRegistry.js";

// 仅测试租约状态，不作为真实窗口证据。
function candidate(): NativeScenePublicationCandidate {
  const digest = "a".repeat(64), at = "2026-09-15T00:00:00.000Z";
  const capabilities = ["deep.scene.runtime.v1", "deep.scene.camera.v1"];
  const evidence: PublicationCapabilityEvidence[] = capabilities.map(capability => ({ id: capability, capability,
    target: "deep-native", sourceSemanticHash: digest, compileGraphHash: digest, targetArtifactHash: digest,
    scope: "native-window", fixtureId: `scene-${digest}`, platform: "windows-x64" }));
  const report = summarizeScenePublicationCompatibility({ target: "deep-native", sceneId: "s", contentFingerprint: digest,
    compileGraphHash: digest, targetArtifactHash: digest, fixtureId: `scene-${digest}`, platform: "windows-x64",
    profile: { version: "deep-scene-compiled-v1", capabilities }, evidence,
    items: capabilities.map((capability, index) => ({ sceneId: "s", objectId: "s", path: index ? "camera" : "$",
      capability, status: "supported", reason: "测试", remediation: "重新验证", evidenceIds: [capability] })) });
  return { actorId: "u", scene: { schemaVersion: 1, projectId: "p", id: "s", name: "s", models: [], primitives: [], measurements: [],
    camera: { mode: "orbit", position: { x: 0, y: 1, z: 2 }, target: { x: 0, y: 0, z: 0 } }, createdAt: at, updatedAt: at },
    capture: { inputs: { project: { id: "p", name: "p", description: "", models: [] }, applications: [],
      runtime: { connections: [], datasets: [], pipelines: [] }, resources: [] }, resources: [],
      nativeCompiled: { runtimePackage: { key: `projects/p/publication-resources/sha256/${digest}`, bytes: 1, sha256: digest },
        compilationEvidence: { sourceSemanticHash: digest, compileGraphHash: digest, targetArtifactHash: digest },
        compatibilityReport: report, compilerSha256: digest, executableSha256: digest, verifiedAt: at } } };
}

it("isolates caller memory, reserves once and consumes only after commit", () => {
  const registry = createNativeSceneCandidateRegistry(), value = candidate(), original = structuredClone(value.scene);
  const { candidateId } = registry.register(value); value.scene.name = "changed";
  const lease = registry.reserve(candidateId, "u", original);
  expect(lease.value.scene.name).toBe("s");
  expect(() => registry.reserve(candidateId, "u", original)).toThrow("正在发布");
  lease.value.scene.name = "mutated lease"; lease.release();
  const next = registry.reserve(candidateId, "u", original); expect(next.value.scene.name).toBe("s");
  next.commit(); expect(() => registry.reserve(candidateId, "u", original)).toThrow("不存在");
  expect(() => next.commit()).toThrow("失效"); next.release();
});
it("rejects different owners, projects and changed snapshots without consuming the candidate", () => {
  const registry = createNativeSceneCandidateRegistry(), value = candidate(), { candidateId } = registry.register(value);
  expect(() => registry.reserve(candidateId, "foreign", value.scene)).toThrow("不存在");
  expect(() => registry.reserve(candidateId, "u", { ...value.scene, projectId: "foreign" })).toThrow("不存在");
  expect(() => registry.reserve(candidateId, "u", { ...value.scene, name: "changed" })).toThrow("场景已变化");
  registry.reserve(candidateId, "u", value.scene).commit();
});
it("expires idle candidates while allowing an already reserved transaction to settle", () => {
  let time = 1_000; const registry = createNativeSceneCandidateRegistry(() => time), value = candidate();
  const idle = registry.register(value), active = registry.register(value);
  const lease = registry.reserve(active.candidateId, "u", value.scene);
  time += 600_000;
  expect(() => registry.reserve(idle.candidateId, "u", value.scene)).toThrow("过期");
  lease.commit();
});
it("bounds outstanding candidates and rejects invalid stored reports", () => {
  const registry = createNativeSceneCandidateRegistry(), value = candidate();
  for (let index = 0; index < 16; index++) registry.register(value);
  expect(() => registry.register(value)).toThrow("限额");
  value.capture.nativeCompiled!.runtimePackage.sha256 = "b".repeat(64);
  expect(() => createNativeSceneCandidateRegistry().register(value)).toThrow("无效");
});
