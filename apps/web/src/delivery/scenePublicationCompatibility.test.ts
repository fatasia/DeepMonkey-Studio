import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import type { PublicationCapabilityEvidence, SceneSnapshot } from "@bim-studio/contracts";
import { compileSceneRuntimePackage } from "./compileSceneRuntimePackage";
import { assessCompiledScenePublication } from "./scenePublicationCompatibility";

function scene(): SceneSnapshot {
  return { schemaVersion: 1, id: "scene", projectId: "project", name: "兼容夹具", models: [],
    primitives: [{ modelId: "box", kind: "box", name: "方块", visible: true, opacity: 1, color: "#ffffff",
      transform: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } } }],
    camera: { mode: "orbit", position: { x: 1, y: 2, z: 3 }, target: { x: 0, y: 0, z: 0 } },
    measurements: [], createdAt: "created", updatedAt: "saved" };
}
async function fixture() {
  const source = scene();
  const compiled = await compileSceneRuntimePackage(source, { packageId: "fixture", packageVersion: "1.0.0", loadModel: vi.fn() });
  const options = { compilation: compiled.evidence, fixtureId: "fixture", platform: "windows-x64" };
  return { source, compiled, options };
}

describe("compiled scene publication audit", () => {
  it("recomputes omitted source fields and keeps reported blockers without duplicate object items", async () => {
    const source = scene();
    source.weather = "sunny";
    Object.assign(source.primitives[0]!, { futureBehavior: { enabled: true } });
    const compiled = await compileSceneRuntimePackage(source, { packageId: "hidden-fields", packageVersion: "1.0.0", loadModel: vi.fn() });
    const compilation = { ...compiled.evidence, deferredSceneFields: ["reportedSceneField"],
      deferredObjectFields: [{ nodeId: "box", fields: ["futureBehavior", "reportedObjectField"] }] };
    const report = assessCompiledScenePublication(source, { compilation, fixtureId: "fixture", platform: "windows-x64" });
    for (const path of ["weather", "reportedSceneField", 'objects["box"].futureBehavior', 'objects["box"].reportedObjectField']) {
      expect(report.items.filter(item => item.path === path)).toEqual([expect.objectContaining({ status: "blocked" })]);
    }
    compilation.deferredObjectFields = [];
    const omitted = assessCompiledScenePublication(source, { compilation, fixtureId: "fixture", platform: "windows-x64" });
    expect(omitted.items).toContainEqual(expect.objectContaining({ path: 'objects["box"].futureBehavior', status: "blocked" }));
  });
  it("blocks mismatched local coordinate evidence and unsupported source budgets", async () => {
    const { source, options } = await fixture();
    for (const compilation of [
      { ...options.compilation, localCoordinates: { ...options.compilation.localCoordinates, origin: { x: 1000, y: 0, z: 0 } } },
      { ...options.compilation, maxSourceBytes: 0 },
      { ...options.compilation, maxSourceBytes: 256 * 1024 * 1024 + 1 },
    ]) {
      const report = assessCompiledScenePublication(source, { ...options, compilation });
      expect(report.items).toContainEqual(expect.objectContaining({ path: "$coordinates", status: "blocked" }));
    }
  });
  it("recognizes a real compiled GLB instance without claiming Native runtime readiness", async () => {
    const source = scene();
    source.models = [{ modelId: "pump", assetModelId: "asset", name: "设备", visible: true, opacity: 1,
      transform: source.primitives[0]!.transform }];
    source.primitives = [];
    const bytes = readFileSync(new URL("../../../../packages/deep-engine/lab/assets/Box.glb", import.meta.url));
    const compiled = await compileSceneRuntimePackage(source, { packageId: "glb-fixture", packageVersion: "1.0.0", loadModel: async () => bytes });
    const report = assessCompiledScenePublication(source, { compilation: compiled.evidence, fixtureId: "glb-fixture", platform: "windows-x64" });
    expect(report.items).toContainEqual(expect.objectContaining({ objectId: "pump", capability: "deep.scene.static-glb.v1", status: "blocked" }));
    expect(report.items.some((item) => item.reason.includes("缺少编译映射"))).toBe(false);
  });
  it("consumes actual compiler output without treating CPU compilation as Native support", async () => {
    const { source, compiled, options } = await fixture();
    const report = assessCompiledScenePublication(source, options);
    expect(report.status).toBe("blocked");
    expect(report.contentFingerprint).toBe(compiled.evidence.sourceSemanticHash);
    expect(report.targetArtifactHash).toBe(compiled.evidence.targetArtifactHash);
    expect(report.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ objectId: "box", capability: "deep.scene.static-primitives.v1", status: "blocked" }),
      expect.objectContaining({ path: "camera", capability: "deep.scene.camera.v1", status: "blocked" }),
    ]));
  });

  it("invalidates evidence when the saved source changes", async () => {
    const { source, options } = await fixture();
    source.camera.position.x++;
    expect(assessCompiledScenePublication(source, options).items).toContainEqual(expect.objectContaining({ path: "$source", status: "blocked" }));
  });

  it("requires exact object mappings and rejects duplicate render identities", async () => {
    const { source, options } = await fixture();
    for (const bindings of [[], [{ nodeId: "box", instanceIds: [] }], [{ nodeId: "foreign", instanceIds: ["draw"] }],
      [{ nodeId: "box", instanceIds: ["same", "same"] }], [{ nodeId: "box", instanceIds: ["a"] }, { nodeId: "box", instanceIds: ["b"] }]]) {
      const report = assessCompiledScenePublication(source, { ...options, compilation: { ...options.compilation, objectBindings: bindings } });
      expect(report.items.some((item) => /映射|实例/.test(item.reason))).toBe(true);
      expect(report.status).toBe("blocked");
    }
  });

  it("keeps compiler-reported unknown scene and object fields as actionable blockers", async () => {
    const { source, options } = await fixture();
    const report = assessCompiledScenePublication(source, { ...options, compilation: { ...options.compilation,
      deferredSceneFields: ["futureField", "dashboard"], deferredObjectFields: [{ nodeId: "box", fields: ["animationPlayback", "futureMaterial"] }] } });
    expect(report.items.filter((item) => item.capability === "deep.scene.uncompiled.v1")).toHaveLength(4);
    expect(report.items).toContainEqual(expect.objectContaining({ objectId: "box", reason: "对象字段 animationPlayback 尚未进入运行包。" }));
  });

  it("does not let matching runtime claims erase uncompiled semantics", async () => {
    const { source, options } = await fixture();
    const runtimeEvidence: PublicationCapabilityEvidence[] = ["deep.scene.runtime.v1", "deep.scene.static-primitives.v1"].map((capability) => ({
      id: capability, capability, target: "deep-native", scope: "native-window", fixtureId: options.fixtureId, platform: options.platform,
      sourceSemanticHash: options.compilation.sourceSemanticHash, compileGraphHash: options.compilation.compileGraphHash,
      targetArtifactHash: options.compilation.targetArtifactHash,
    }));
    const report = assessCompiledScenePublication(source, { ...options, runtimeEvidence });
    expect(report.items.find((item) => item.objectId === "box")?.status).toBe("supported");
    expect(report.items.find((item) => item.path === "camera")?.status).toBe("blocked");
    expect(report.status).toBe("blocked");
  });

  it("does not confuse omitted optional properties with changed saved content", async () => {
    const { source, options } = await fixture();
    const report = assessCompiledScenePublication({ ...source, thumbnail: undefined } as unknown as SceneSnapshot, options);
    expect(report.items.some((item) => item.path === "$source")).toBe(false);
    source.camera.position.x = NaN;
    expect(() => assessCompiledScenePublication(source, options)).toThrow(/JSON/);
  });

  it("requires exact Native camera evidence independently of compiled geometry", async () => {
    const { source, options } = await fixture();
    const compilation = { ...options.compilation, deferredSceneFields: options.compilation.deferredSceneFields.filter((field) => field !== "camera") };
    const proof: PublicationCapabilityEvidence = { id: "camera-proof", capability: "deep.scene.camera.v1", target: "deep-native",
      scope: "native-window", fixtureId: options.fixtureId, platform: options.platform,
      sourceSemanticHash: options.compilation.sourceSemanticHash, compileGraphHash: options.compilation.compileGraphHash,
      targetArtifactHash: options.compilation.targetArtifactHash };
    const cameraItem = (runtimeEvidence: PublicationCapabilityEvidence[]) => assessCompiledScenePublication(source, { ...options, compilation, runtimeEvidence }).items.find((item) => item.path === "camera");
    expect(cameraItem([])?.status).toBe("blocked");
    expect(cameraItem([{ ...proof, scope: "static-render-packet" }])?.status).toBe("blocked");
    expect(cameraItem([{ ...proof, targetArtifactHash: "d".repeat(64) }])?.status).toBe("blocked");
    expect(cameraItem([proof])).toMatchObject({ capability: "deep.scene.camera.v1", status: "supported", evidenceIds: ["camera-proof"] });
    expect(assessCompiledScenePublication(source, { ...options, runtimeEvidence: [proof] }).status).toBe("blocked");
  });

  it("rejects unknown, duplicate, conflicting and incorrect compiled field resource mappings", async () => {
    const { source, options } = await fixture();
    const camera = { field: "camera", capability: "deep.scene.camera.v1", resourceId: "scene.camera" };
    for (const fields of [[{ ...camera, field: "futureField" }], [{ ...camera, capability: "deep.scene.unknown.v1" }],
      [{ ...camera, resourceId: "scene.geometry" }], [{ ...camera, resourceId: "" }], [camera, camera]]) {
      const report = assessCompiledScenePublication(source, { ...options, compilation: { ...options.compilation, compiledSceneFields: fields } });
      expect(report.items.some((item) => /映射未知|映射重复|能力检查重复/.test(item.reason))).toBe(true);
      expect(report.status).toBe("blocked");
    }
    const conflict = assessCompiledScenePublication(source, { ...options, compilation: { ...options.compilation, deferredSceneFields: ["camera"] } });
    expect(conflict.items.some((item) => item.reason.includes("同时标记"))).toBe(true);
  });

  it("does not drop mandatory camera semantics when both compiled and deferred fields omit them", async () => {
    const { source, options } = await fixture();
    for (const compiledSceneFields of [[], undefined]) {
      const compilation = { ...options.compilation, compiledSceneFields, deferredSceneFields: [] } as unknown as typeof options.compilation;
      const report = assessCompiledScenePublication(source, { ...options, compilation });
      expect(report.items).toContainEqual(expect.objectContaining({ path: "camera", status: "blocked", reason: "相机缺少编译字段映射。" }));
    }
  });
});
