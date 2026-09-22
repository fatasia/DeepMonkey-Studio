import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import type { PublicationCapabilityEvidence, SceneSnapshot } from "@bim-studio/contracts";
import { compileSceneRuntimePackage } from "./compileSceneRuntimePackage";
import { assessCompiledScenePublication } from "./scenePublicationCompatibility";
import { createIndustrialShowcaseBundle } from "../showcase/industrialShowcase";
import { DEFAULT_POST_PROCESSING } from "../appDefaults";

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
  it("keeps the real robot-health showcase free of the generic effects blocker", async () => {
    const bundle = createIndustrialShowcaseBundle({ projectId: "showcase-project", showcaseId: "native-preflight", createdAt: "2026-09-21T00:00:00.000Z" });
    const source = bundle.scenes.find(candidate => candidate.name === "机器人 A · 部件拆解与健康");
    expect(source).toBeDefined();
    const compiled = await compileSceneRuntimePackage(source!, {
      packageId: "robot-health-native", packageVersion: "1.0.0", loadModel: vi.fn(),
    });
    const report = assessCompiledScenePublication(source!, {
      compilation: compiled.evidence, fixtureId: "robot-health-native", platform: "windows-x64",
    });
    expect(report.items).not.toContainEqual(expect.objectContaining({
      path: expect.stringMatching(/\.effects$/), capability: "deep.scene.uncompiled.v1", status: "blocked",
    }));
    const uncompiled = report.items.filter(item => item.capability === "deep.scene.uncompiled.v1");
    expect(uncompiled.map(item => item.path)).toEqual([
      "dataBindings", "environment", "lighting", "navigationSettings", "postProcessing",
    ]);
    expect(report.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "cameraViews", capability: "deep.scene.camera-views.v1" }),
      expect.objectContaining({ path: "defaultCameraViewId", capability: "deep.scene.camera-views.v1" }),
    ]));
    expect(uncompiled.find(item => item.path === "navigationSettings")?.reason)
      .toContain("walk/fly、冲刺、重力、跳跃、步高和坡度");
  });
  it("reports the exact Native blocker for every non-neutral color grading channel", async () => {
    const source = scene();
    source.postProcessing = { ...DEFAULT_POST_PROCESSING, enabled: true, colorGrading: true, hue: 12, saturation: 0, brightness: 0,
      contrast: 0, temperature: 0, tint: 0 };
    const compiled = await compileSceneRuntimePackage(source, {
      packageId: "native-color-grading", packageVersion: "1.0.0", loadModel: vi.fn(),
    });
    const report = assessCompiledScenePublication(source, {
      compilation: compiled.evidence, fixtureId: "native-color-grading", platform: "windows-x64",
    });
    expect(report.items).toContainEqual(expect.objectContaining({
      path: "postProcessing", status: "degraded",
      reason: "Deep Native 尚未实现作者色彩分级后处理消费（色相/饱和度/亮度/对比度/色温/色调）；该效果当前仅由 Studio Deep WebGPU 与 WebGL 运行。",
    }));
  });
  it("uses existing Native camera evidence for orbit collision constraints and precisely blocks unsupported navigation", async () => {
    const source = scene();
    source.cameraConstraints = { minDistance: 1, maxDistance: 80, minPolarAngle: 5, maxPolarAngle: 165,
      nearClip: 0.02, farClip: 5000, collisionEnabled: true, collisionRadius: 0.45 };
    const compiled = await compileSceneRuntimePackage(source, { packageId: "orbit-collision", packageVersion: "1.0.0", loadModel: vi.fn() });
    const proof: PublicationCapabilityEvidence = { id: "native-camera", capability: "deep.scene.camera.v1", target: "deep-native",
      scope: "native-window", fixtureId: "orbit-collision", platform: "windows-x64",
      sourceSemanticHash: compiled.evidence.sourceSemanticHash, compileGraphHash: compiled.evidence.compileGraphHash,
      targetArtifactHash: compiled.evidence.targetArtifactHash };
    const supported = assessCompiledScenePublication(source, {
      compilation: compiled.evidence, fixtureId: "orbit-collision", platform: "windows-x64", runtimeEvidence: [proof],
    });
    expect(supported.items.find(item => item.path === "cameraConstraints")).toMatchObject({
      capability: "deep.scene.camera.v1", status: "supported", evidenceIds: ["native-camera"],
    });
    expect(supported.items).not.toContainEqual(expect.objectContaining({
      path: "cameraConstraints", capability: "deep.scene.uncompiled.v1",
    }));

    source.navigationSettings = { walkSpeed: 7, flySpeed: 11, sprintMultiplier: 3, eyeHeight: 1.8,
      gravity: 10, jumpSpeed: 6, stepHeight: 0.4, maxSlopeAngle: 42 };
    source.camera.mode = "firstPerson";
    const unsupported = await compileSceneRuntimePackage(source, { packageId: "walk", packageVersion: "1.0.0", loadModel: vi.fn() });
    const report = assessCompiledScenePublication(source, {
      compilation: unsupported.evidence, fixtureId: "walk", platform: "windows-x64",
    });
    expect(report.items.find(item => item.path === "camera")).toMatchObject({ status: "degraded" });
    expect(report.items.find(item => item.path === "camera")?.reason).toContain("回退为 orbit");
    expect(report.items.find(item => item.path === "navigationSettings")).toMatchObject({ status: "degraded" });
    expect(report.items.find(item => item.path === "navigationSettings")?.reason).toContain("walk/fly");
    expect(report.items.find(item => item.path === "cameraConstraints")).toMatchObject({
      capability: "deep.scene.camera.v1", status: "blocked",
    });
  });
  it("does not reclassify a compiled object outline as an uncompiled effects field", async () => {
    const source = scene();
    source.primitives[0]!.effects = { outline: true, glow: false, xray: false, scanline: false,
      heatmap: false, edgeLight: false, dissolve: 0, intensity: 1, color: "#36a3ff" };
    const compiled = await compileSceneRuntimePackage(source, {
      packageId: "outlined", packageVersion: "1.0.0", loadModel: vi.fn(),
    });
    const packet = compiled.runtimePackage.payloads[compiled.runtimePackage.entrypoints.renderPacket] as { instances: Array<{ outline?: boolean }> };
    expect(packet.instances[0]!.outline).toBe(true);
    const report = assessCompiledScenePublication(source, { compilation: compiled.evidence, fixtureId: "outlined", platform: "windows-x64" });
    expect(report.items).not.toContainEqual(expect.objectContaining({ path: 'objects["box"].effects', status: "blocked" }));
  });
  it("treats compiled road prefab paths as consumed object state", async () => {
    const source = scene();
    source.primitives[0] = { ...source.primitives[0]!, modelId: "road", kind: "box", name: "Road",
      prefab: { definitionId: "road.straight", definitionVersion: "1.0.0", kind: "road", operatingState: "idle",
        parameters: { lengthM: 20, carriagewayWidthM: 7, laneCount: 2, shoulderWidthM: 0.75, surface: "asphalt", marking: "center" },
        placementPath: { points: [{ id: "a", position: { x: 0, y: 0, z: 0 } }, { id: "b", position: { x: 12, y: 0, z: 3 } }],
          interpolation: "linear", closed: false, snapToGround: false, seed: 9 } } } as typeof source.primitives[number];
    const compiled = await compileSceneRuntimePackage(source, { packageId: "road-prefab", packageVersion: "1.0.0", loadModel: vi.fn() });
    const report = assessCompiledScenePublication(source, { compilation: compiled.evidence, fixtureId: "road-prefab", platform: "windows-x64" });
    expect(report.items).not.toContainEqual(expect.objectContaining({ path: 'objects["road"].prefab', status: "blocked" }));
  });
  it("recomputes omitted source fields and keeps reported blockers without duplicate object items", async () => {
    const source = scene();
    source.weather = "rain";
    Object.assign(source.primitives[0]!, { futureBehavior: { enabled: true } });
    const compiled = await compileSceneRuntimePackage(source, { packageId: "hidden-fields", packageVersion: "1.0.0", loadModel: vi.fn() });
    const compilation = { ...compiled.evidence, deferredSceneFields: ["reportedSceneField"],
      deferredObjectFields: [{ nodeId: "box", fields: ["futureBehavior", "reportedObjectField"] }] };
    const report = assessCompiledScenePublication(source, { compilation, fixtureId: "fixture", platform: "windows-x64" });
    for (const path of ["weather", "reportedSceneField", 'objects["box"].futureBehavior', 'objects["box"].reportedObjectField']) {
      expect(report.items.filter(item => item.path === path)).toEqual([expect.objectContaining({ status: path === "weather" ? "degraded" : "blocked" })]);
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
