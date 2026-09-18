import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { SceneSnapshot } from "@bim-studio/contracts";
import { parseDeepRuntimePackage, runtimeContentSha256 } from "@bim-studio/deep-engine/runtime-package";
import { compileSceneRuntimePackage } from "./compileSceneRuntimePackage";

function scene(): SceneSnapshot {
  return { schemaVersion: 1, id: "source", projectId: "project", name: "fixture", primitives: [], models: [], measurements: [],
    camera: { mode: "orbit", position: { x: 0, y: 1, z: 5 }, target: { x: 0, y: 0, z: 0 } }, createdAt: "", updatedAt: "" };
}
const bytes = readFileSync(new URL("../../../../packages/deep-engine/lab/assets/Box.glb", import.meta.url));
const options = { packageId: "scene.compiled", packageVersion: "1.0.0", loadModel: async () => bytes };
function withModel(): SceneSnapshot {
  return { ...scene(), models: [{ modelId: "instance", assetModelId: "asset", name: "model", visible: true, opacity: 1,
    transform: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } } }] };
}

describe("scene runtime compilation evidence", () => {
  it.each(["mode", "avatar", "unknown"])("keeps uncompiled camera %s semantics deferred", async kind => {
    const input = withModel();
    if (kind === "mode") input.camera.mode = "firstPerson";
    if (kind === "avatar") input.camera.avatarVisible = true;
    if (kind === "unknown") Object.assign(input.camera, { roll: 30 });
    const result = await compileSceneRuntimePackage(input, options);
    expect(result.evidence.deferredSceneFields).toContain("camera");
    expect(result.evidence.compiledSceneFields[0]!.capability).toBe("deep.scene.camera.v1");
  });
  it("produces a real runtime file with independently verified input and artifact hashes", async () => {
    const result = await compileSceneRuntimePackage(withModel(), options);
    expect(parseDeepRuntimePackage(result.packageJson)).toMatchObject({ valid: true, value: result.runtimePackage });
    expect(result.evidence.sourceAssets).toEqual([{ assetId: "asset", bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex") }]);
    expect(result.evidence.targetArtifactHash).toBe(createHash("sha256").update(result.packageJson).digest("hex"));
    expect(result.evidence.targetArtifactHash).not.toBe(result.runtimePackage.packageHash.value);
    expect(result.evidence.objectBindings).toMatchObject([{ nodeId: "instance", instanceIds: [expect.any(String)] }]);
    expect(result.evidence.deferredSceneFields).not.toContain("camera");
    expect(result.evidence.scope).toBe("static-render-packet");
    expect(result.runtimePackage.schemaVersion).toBe(3);
    expect(result.evidence.compiledSceneFields).toEqual([{ field: "camera", capability: "deep.scene.camera.v1", resourceId: "scene.camera" }]);
    expect(result.runtimePackage.payloads["scene.camera"]).toMatchObject({ position: [0, 1, 5], target: [0, 0, 0], verticalFovDegrees: 50 });
    expect(result.evidence.recipe).toBe("deep-scene-static-compile-v5");
    expect(result.evidence.maxSourceBytes).toBe(256 * 1024 * 1024);
    expect(result.evidence.localCoordinates.origin).toEqual({ x: 0, y: 0, z: 0 });
  });

  it.each([1e6, 1e9])("preserves local packets and embeds distinct world frames at offset %s", async offset => {
    const near = withModel(); near.models[0]!.transform.position = { x: 0.125, y: -2.25, z: 10.5 };
    near.primitives = [{ ...structuredClone(near.models[0]!), modelId: "box", kind: "box", color: "#808080" }];
    const far = structuredClone(near);
    for (const object of [...far.models, ...far.primitives]) {
      for (const axis of ["x", "y", "z"] as const) object.transform.position[axis] += offset;
    }
    for (const vector of [far.camera.position, far.camera.target]) for (const axis of ["x", "y", "z"] as const) vector[axis] += offset;
    const before = structuredClone(far);
    const [first, second] = await Promise.all([compileSceneRuntimePackage(near, options), compileSceneRuntimePackage(far, options)]);
    expect(second.packageJson).not.toBe(first.packageJson);
    expect(second.evidence.targetArtifactHash).not.toBe(first.evidence.targetArtifactHash);
    const cameras = [first, second].map(result => JSON.parse(result.packageJson).payloads["scene.camera"]);
    const { coordinateFrame: nearFrame, ...nearCamera } = cameras[0];
    const { coordinateFrame: farFrame, ...farCamera } = cameras[1];
    expect(farCamera).toEqual(nearCamera);
    expect(farFrame).not.toEqual(nearFrame);
    for (const [index, source] of [near, far].entries()) {
      expect(cameras[index].schemaVersion).toBe(2);
      for (const key of ["position", "target"] as const) {
        expect(cameras[index][key].map((value: number, axis: number) =>
          value + cameras[index].coordinateFrame.origin[["x", "y", "z"][axis]!]))
          .toEqual([source.camera[key].x, source.camera[key].y, source.camera[key].z]);
      }
    }
    expect(second.runtimePackage.payloads[second.runtimePackage.entrypoints.renderPacket])
      .toEqual(first.runtimePackage.payloads[first.runtimePackage.entrypoints.renderPacket]);
    expect(second.evidence.sourceSemanticHash).not.toBe(first.evidence.sourceSemanticHash);
    expect(second.evidence.compileGraphHash).not.toBe(first.evidence.compileGraphHash);
    expect(second.evidence.objectBindings).toEqual(first.evidence.objectBindings);
    expect(second.evidence.localCoordinates.origin).toEqual({ x: offset, y: offset, z: offset });
    expect(far).toEqual(before);
  });

  it("binds the exact coordinate frame and actual source budget into the compile graph", async () => {
    const result = await compileSceneRuntimePackage(withModel(), { ...options, maxSourceBytes: 4096 });
    const { evidence, runtimePackage: runtime } = result;
    expect(evidence.maxSourceBytes).toBe(4096);
    expect(evidence.compileGraphHash).toBe(runtimeContentSha256({ recipe: evidence.recipe,
      sourceSemanticHash: evidence.sourceSemanticHash, sourceAssets: evidence.sourceAssets,
      packageId: runtime.packageId, packageVersion: runtime.packageVersion, maxSourceBytes: 4096,
      localCoordinates: evidence.localCoordinates,
      cameraHash: runtime.resources.find(resource => resource.kind === "scene-camera")!.contentHash.value,
      renderPacketHash: runtime.resources.find(resource => resource.kind === "render-packet")!.contentHash.value }));
  });

  it("rejects local precision loss before resource reads and preserves the source", async () => {
    const source = withModel(); source.models[0]!.transform.position.x = 1e6 + 0.01;
    const before = structuredClone(source), loadModel = vi.fn(options.loadModel);
    await expect(compileSceneRuntimePackage(source, { ...options, loadModel })).rejects.toThrow(/Float32 误差/);
    expect(loadModel).not.toHaveBeenCalled(); expect(source).toEqual(before);
  });

  it("is deterministic and distinguishes source, compile inputs and artifact identity", async () => {
    const input = withModel(), a = await compileSceneRuntimePackage(input, options);
    expect(await compileSceneRuntimePackage(input, options)).toEqual(a);
    const b = await compileSceneRuntimePackage(input, { ...options, packageVersion: "1.0.1" });
    expect(b.evidence.sourceSemanticHash).toBe(a.evidence.sourceSemanticHash);
    expect(b.evidence.compileGraphHash).not.toBe(a.evidence.compileGraphHash);
    expect(b.evidence.targetArtifactHash).not.toBe(a.evidence.targetArtifactHash);
    input.camera.position.x = 4;
    const c = await compileSceneRuntimePackage(input, options);
    expect(c.evidence.sourceSemanticHash).not.toBe(a.evidence.sourceSemanticHash);
    expect(c.evidence.compileGraphHash).not.toBe(a.evidence.compileGraphHash);
    expect(c.evidence.targetArtifactHash).not.toBe(a.evidence.targetArtifactHash);
  });

  it("records differing asset bytes even when they render the same geometry", async () => {
    const a = await compileSceneRuntimePackage(withModel(), options);
    const alternate = readFileSync(new URL("../../../../packages/deep-engine/lab/assets/BoxInterleaved.glb", import.meta.url));
    const b = await compileSceneRuntimePackage(withModel(), { ...options, loadModel: async () => alternate });
    expect(b.evidence.sourceSemanticHash).toBe(a.evidence.sourceSemanticHash);
    expect(b.evidence.sourceAssets[0]!.sha256).not.toBe(a.evidence.sourceAssets[0]!.sha256);
    expect(b.evidence.compileGraphHash).not.toBe(a.evidence.compileGraphHash);
  });

  it("preserves the exact source identity while the host awaits loading", async () => {
    const input = withModel(), original = structuredClone(input);
    const result = await compileSceneRuntimePackage(input, { ...options, loadModel: async () => {
      input.camera.position.x = 999; input.models = []; return bytes;
    } });
    expect(result).toEqual(await compileSceneRuntimePackage(original, options));
  });

  it("rejects invalid semantic numbers and cancellation before reading resources", async () => {
    const input = withModel(), loadModel = vi.fn(async () => bytes);
    input.camera.position.x = NaN;
    await expect(compileSceneRuntimePackage(input, { ...options, loadModel })).rejects.toThrow(/非有限/);
    const controller = new AbortController(); controller.abort();
    await expect(compileSceneRuntimePackage(withModel(), { ...options, loadModel, signal: controller.signal })).rejects.toThrow();
    expect(loadModel).not.toHaveBeenCalled();
  });

  it("identifies object behavior still absent from the static runtime package", async () => {
    const input = withModel();
    input.models[0]!.animationPlayback = { autoplay: true, loopMode: "loop" };
    const result = await compileSceneRuntimePackage(input, options);
    expect(result.evidence.deferredObjectFields).toEqual([{ nodeId: "instance", fields: ["animationPlayback"] }]);
  });
});
