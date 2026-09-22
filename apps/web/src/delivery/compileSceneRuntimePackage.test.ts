import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { SceneSnapshot } from "@bim-studio/contracts";
import { parseDeepRuntimePackage, runtimeContentSha256 } from "@bim-studio/deep-engine/runtime-package";
import { compileSceneRuntimePackage } from "./compileSceneRuntimePackage";
import { applyDynamicRuntimeFrame } from "./dynamicRuntimePlayback";
import { DynamicAnimationControllerPlayer } from "./dynamicAnimationControllerPlayback";

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
  it("carries the saved animation controller through the formal package and Web player", async () => {
    const input = withModel();
    input.animation = {
      duration: 0,
      loop: false,
      camera: [],
      models: [],
      stateMachine: {
        enabled: true,
        initialStateId: "idle",
        activeStateId: "idle",
        transitionDuration: 0.25,
        states: [
          { id: "idle", name: "Idle", modelId: "instance", clipId: "Idle", loop: true },
          { id: "work", name: "Work", modelId: "instance", clipId: "Work", loop: true },
        ],
        parameters: { advance: false },
        transitions: [{ id: "idle-work", fromStateId: "idle", toStateId: "work", parameter: "advance", equals: true }],
      },
    };
    const result = await compileSceneRuntimePackage(input, options);
    expect(parseDeepRuntimePackage(result.packageJson)).toMatchObject({ valid: true });
    expect(result.runtimePackage.payloads[result.runtimePackage.entrypoints.dynamicRuntime!]).toMatchObject({
      schemaVersion: 2,
      animationController: {
        schemaVersion: 1,
        activeStateId: "idle",
        transitionDurationMs: 250,
        parameters: { advance: false },
      },
    });
    expect(result.evidence.compiledSceneFields).toContainEqual({
      field: "animation",
      capability: "deep.scene.dynamic-runtime.v1",
      resourceId: "scene.dynamic",
    });
    expect(result.evidence.deferredSceneFields).not.toContain("animation");
    const transitions: unknown[] = [];
    const player = new DynamicAnimationControllerPlayer(result.runtimePackage, {
      playClip: () => true,
      transitionClip: transition => (transitions.push(transition), true),
    });
    expect(player.start()).toBe(true);
    expect(player.setParameter("advance", true)).toBe(true);
    expect(player.evaluate()).toMatchObject({ applied: true, activeStateId: "work" });
    expect(transitions).toEqual([{
      modelId: "instance",
      fromClipId: "Idle",
      toClipId: "Work",
      durationMs: 250,
      loop: true,
    }]);
  });

  it("does not misreport a disabled controller as compiled when physics creates the dynamic resource", async () => {
    const input = withModel();
    input.models[0]!.physics = { type: "dynamic", mass: 1, friction: 0.5, restitution: 0 };
    input.physics = { enabled: true, playing: false, gravity: { x: 0, y: -9.81, z: 0 } };
    input.animation = { duration: 0, loop: false, camera: [], models: [], stateMachine: {
      enabled: false, initialStateId: "idle", activeStateId: "idle", transitionDuration: 0.2,
      states: [{ id: "idle", name: "Idle", modelId: "instance", clipId: "Idle", loop: true }],
    } };
    const result = await compileSceneRuntimePackage(input, options);
    expect(result.evidence.deferredSceneFields).toContain("animation");
    expect(result.evidence.compiledSceneFields).not.toContainEqual(expect.objectContaining({ field: "animation" }));
  });

  it("compiles authored rigid bodies and joints into the validated v3 dynamic runtime", async () => {
    const input = withModel();
    input.models[0]!.physics = { type: "dynamic", mass: 2, friction: 0.5, restitution: 0.1 };
    input.physics = { enabled: true, playing: true, gravity: { x: 0, y: -9.81, z: 0 }, joints: [{
      id: "joint-a", kind: "revolute", bodyId: "instance", worldAnchor: { x: 0, y: 1, z: 0 },
      localAnchor: { x: 0, y: 1, z: 0 }, axis: { x: 0, y: 1, z: 0 },
      limits: { enabled: true, min: -1, max: 1 }, motor: { enabled: true, targetVelocity: 2, strength: 4 },
    }] };
    const result = await compileSceneRuntimePackage(input, options);
    expect(parseDeepRuntimePackage(result.packageJson)).toMatchObject({ valid: true });
    const payload = result.runtimePackage.payloads[result.runtimePackage.entrypoints.dynamicRuntime!];
    expect(payload).toMatchObject({ schemaVersion: 3, physics: { schemaVersion: 1, playing: true,
      bodies: [{ id: "instance", type: "dynamic", collider: { kind: "render-bounds", instanceIds: [expect.any(String)] } }],
      joints: [{ id: "joint-a", solver: "impulse", connectedBodyId: null }] } });
    expect(result.evidence.compiledSceneFields).toContainEqual({ field: "physics", capability: "deep.scene.physics-runtime.v1", resourceId: "scene.dynamic" });
    expect(result.evidence.deferredSceneFields).not.toContain("physics");
    expect(result.evidence.deferredObjectFields).not.toContainEqual(expect.objectContaining({ nodeId: "instance", fields: expect.arrayContaining(["physics"]) }));
  });

  it.each(["mode", "avatar", "unknown"])("keeps uncompiled camera %s semantics deferred", async kind => {
    const input = withModel();
    if (kind === "mode") input.camera.mode = "firstPerson";
    if (kind === "avatar") input.camera.avatarVisible = true;
    if (kind === "unknown") Object.assign(input.camera, { roll: 30 });
    const result = await compileSceneRuntimePackage(input, options);
    expect(result.evidence.deferredSceneFields).toContain("camera");
    expect(result.evidence.compiledSceneFields[0]!.capability).toBe("deep.scene.camera.v1");
  });
  it("accounts for authored orbit collision constraints while keeping navigation settings deferred", async () => {
    const input = withModel();
    input.cameraConstraints = { minDistance: 1, maxDistance: 80, minPolarAngle: 5, maxPolarAngle: 165,
      nearClip: 0.02, farClip: 5000, collisionEnabled: true, collisionRadius: 0.45 };
    input.navigationSettings = { walkSpeed: 7, flySpeed: 11, sprintMultiplier: 3, eyeHeight: 1.8,
      gravity: 10, jumpSpeed: 6, stepHeight: 0.4, maxSlopeAngle: 42 };
    const result = await compileSceneRuntimePackage(input, options);
    expect(result.runtimePackage.payloads["scene.camera"]).toMatchObject({ schemaVersion: 4, controls: {
      mode: "orbit", collisionEnabled: true, collisionRadius: 0.45, minDistance: 1, maxDistance: 80,
    } });
    expect(result.evidence.compiledSceneFields).toContainEqual({
      field: "cameraConstraints", capability: "deep.scene.camera.v1", resourceId: "scene.camera",
    });
    expect(result.evidence.deferredSceneFields).not.toContain("cameraConstraints");
    expect(result.evidence.deferredSceneFields).toContain("navigationSettings");
  });
  it("does not claim future camera constraint fields as compiled", async () => {
    const input = withModel();
    input.cameraConstraints = { minDistance: 1, maxDistance: 80, minPolarAngle: 5, maxPolarAngle: 165,
      nearClip: 0.02, farClip: 5000, collisionEnabled: true, collisionRadius: 0.45 };
    Object.assign(input.cameraConstraints, { futureCollisionShape: "capsule" });
    const result = await compileSceneRuntimePackage(input, options);
    expect(result.evidence.compiledSceneFields).not.toContainEqual(expect.objectContaining({ field: "cameraConstraints" }));
    expect(result.evidence.deferredSceneFields).toContain("cameraConstraints");
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
      // Framed camera payloads use the current v3 contract. v3 keeps the
      // Unconfigured orbit scenes retain the v3 framed contract. v4 is used
      // only when author controls exist, so unsupported controls cannot turn
      // an otherwise compatible package into a runtime-only failure.
      expect(cameras[index].schemaVersion).toBe(3);
      expect(cameras[index].controls).toBeUndefined();
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
  it("lowers unit-scale model TRS keyframes into the v7 dynamic resource", async () => {
    const input = withModel();
    // B2-b:区间随发布包下译为毫秒播放区间。
    input.animation = { duration: 2, loop: true, playbackRange: { inPoint: 0.2, outPoint: 1.5 }, camera: [], models: [{ id: "frame-0", time: 0, modelId: "instance",
      transform: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } } },
      { id: "frame-1", time: 2, modelId: "instance",
        transform: { position: { x: 1, y: 0, z: 0 }, rotation: { x: 0, y: 0.5, z: 0 }, scale: { x: 1, y: 1, z: 1 } } }] };
    const result = await compileSceneRuntimePackage(input, options);
    expect(result.runtimePackage.schemaVersion).toBe(7);
    expect(result.runtimePackage.entrypoints.dynamicRuntime).toBe("scene.dynamic");
    const dynamic = result.runtimePackage.payloads["scene.dynamic"] as any;
    expect(dynamic.schema).toBe("deep-engine.dynamic-runtime");
    expect(dynamic.animation.durationMs).toBe(2000);
    expect(dynamic.animation.playbackRangeMs).toEqual({ inMs: 200, outMs: 1500 });
    expect(dynamic.animation.tracks).toHaveLength(3);
    expect(dynamic.animation.tracks.map((track: any) => track.property)).toEqual(["translation", "rotation", "scale"]);
    expect(dynamic.animation.tracks[0].keyframes.map((frame: any) => frame.timeMs)).toEqual([0, 2000]);
    expect(result.evidence.compiledSceneFields).toContainEqual({ field: "animation", capability: "deep.scene.dynamic-runtime.v1", resourceId: "scene.dynamic" });
  });

  it("consumes the compiled v7 dynamic resource through Web sampling and frame application", async () => {
    const input = withModel();
    input.animation = { duration: 2, loop: true, camera: [], models: [
      { id: "frame-0", time: 0, modelId: "instance", transform: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } } },
      { id: "frame-1", time: 2, modelId: "instance", transform: { position: { x: 2, y: 0, z: 0 }, rotation: { x: 0, y: Math.PI / 2, z: 0 }, scale: { x: 2, y: 2, z: 2 } } },
    ] };
    const result = await compileSceneRuntimePackage(input, options);
    const applied: Array<{ id: string; transform: unknown }> = [];
    const frame = applyDynamicRuntimeFrame(result.runtimePackage, 1000, {
      applyTransform: (id, transform) => applied.push({ id, transform }),
    });
    expect(frame.timeMs).toBe(1000);
    expect(Object.keys(frame.transforms)).toEqual(["instance"]);
    expect(applied).toHaveLength(1);
    expect(applied[0]).toMatchObject({ id: "instance", transform: {
      translation: [1, 0, 0], scale: [1.5, 1.5, 1.5],
      rotationQuaternion: [0, expect.closeTo(Math.sin(Math.PI / 8)), 0, expect.closeTo(Math.cos(Math.PI / 8))],
    } });
  });

  it("compiles local-coordinate camera animation with autoplay and loop metadata", async () => {
    const input = scene();
    input.camera = { mode: "orbit", position: { x: 1e9 + 10, y: 1e9 + 5, z: 1e9 + 20 }, target: { x: 1e9, y: 1e9, z: 1e9 } };
    input.animation = { duration: 2, autoplay: true, loop: false, models: [], camera: [
      { id: "camera-0", time: 0, camera: structuredClone(input.camera) },
      { id: "camera-1", time: 2, camera: { ...structuredClone(input.camera), position: { x: 1e9 + 20, y: 1e9 + 10, z: 1e9 + 30 }, target: { x: 1e9 + 2, y: 1e9 + 1, z: 1e9 } } },
    ] };
    const result = await compileSceneRuntimePackage(input, options);
    const dynamic = result.runtimePackage.payloads["scene.dynamic"] as any;
    expect(dynamic.animation).toMatchObject({ durationMs: 2000, autoplay: true, loop: false });
    expect(dynamic.animation.tracks.map((track: any) => track.property)).toEqual(["camera-position", "camera-target"]);
    expect(dynamic.animation.tracks[0].keyframes.map((frame: any) => frame.value.slice(0, 3))).toEqual([[10, 5, 20], [20, 10, 30]]);
    const applied: unknown[] = [];
    const frame = applyDynamicRuntimeFrame(result.runtimePackage, 1000, { applyTransform: () => undefined, applyCamera: camera => applied.push(camera) });
    expect(frame.transforms).toEqual({});
    expect(applied).toEqual([{ position: [15, 7.5, 25], target: [1, 0.5, 0] }]);
    expect(result.evidence.deferredSceneFields).not.toContain("animation");
  });
});

describe("F3 probe grid bake delivery", () => {
  /** 2×2×2 网格、8 支确定性探针;origin 用非零作者坐标,顺带证明编译器做了局部化。 */
  function probeBake(origin: readonly [number, number, number] = [4, 5, 6]) {
    const probes = Array.from({ length: 8 }, (_, index) => ({
      irradiance: [index, index * 2, index * 3] as readonly [number, number, number],
      validity: 1, meanDistance: index * 0.5, distanceVariance: index,
    }));
    return { origin, spacing: 1.5, gridSize: [2, 2, 2] as readonly [number, number, number], probes };
  }
  function withEnvironment(): SceneSnapshot {
    return { ...withModel(), environment: { gridVisible: true, backgroundColor: "#101010", skybox: "none" } };
  }

  it("writes a valid probe grid into the environment payload with a localized origin", async () => {
    const result = await compileSceneRuntimePackage(withEnvironment(), { ...options, irradianceProbes: probeBake() });
    expect(parseDeepRuntimePackage(result.packageJson)).toMatchObject({ valid: true });
    const environment = result.runtimePackage.payloads["scene.environment"] as any;
    const frameOrigin = result.evidence.localCoordinates.origin;
    // 打包 origin = 作者 origin − 局部化 frame origin,与相机/几何同一坐标系。
    expect(environment.irradianceProbes).toMatchObject({
      schema: "deep-engine.probe-grid", schemaVersion: 1,
      origin: [4 - frameOrigin.x, 5 - frameOrigin.y, 6 - frameOrigin.z],
      spacing: 1.5, gridSize: [2, 2, 2],
    });
    expect(environment.irradianceProbes.probes).toHaveLength(8);
    expect(environment.irradianceProbes.probes[3].irradiance).toEqual([3, 6, 9]);
    expect(result.evidence.compiledSceneFields).toContainEqual({
      field: "irradianceProbes", capability: "deep.scene.probe-grid.v1", resourceId: "scene.environment" });
  });

  it("omits irradianceProbes entirely when absent or explicitly null", async () => {
    const input = withEnvironment();
    const baseline = await compileSceneRuntimePackage(input, options);
    const explicitNull = await compileSceneRuntimePackage(input, { ...options, irradianceProbes: null });
    for (const result of [baseline, explicitNull]) {
      const environment = result.runtimePackage.payloads["scene.environment"] as any;
      expect(Object.hasOwn(environment, "irradianceProbes")).toBe(false);
      expect(result.evidence.compiledSceneFields).not.toContainEqual(expect.objectContaining({ field: "irradianceProbes" }));
    }
    expect(baseline.runtimePackage.packageHash.value).toBe(explicitNull.runtimePackage.packageHash.value);
  });

  it("fails compilation with a readable message when probe count mismatches the grid volume", async () => {
    const bake = probeBake();
    const bad = { ...bake, probes: bake.probes.slice(0, 7) };
    await expect(compileSceneRuntimePackage(withEnvironment(), { ...options, irradianceProbes: bad }))
      .rejects.toThrowError(/environment irradianceProbes: native-probe-grid: probe-count-mismatch 7 != 8/);
  });

  it("fails closed on an out-of-range probe record before any package bytes are written", async () => {
    const bake = probeBake();
    const probes = [...bake.probes];
    probes[2] = { ...probes[2]!, validity: -0.5 };
    await expect(compileSceneRuntimePackage(withEnvironment(), { ...options, irradianceProbes: { ...bake, probes } }))
      .rejects.toThrowError(/invalid-probe-record/);
  });
});
