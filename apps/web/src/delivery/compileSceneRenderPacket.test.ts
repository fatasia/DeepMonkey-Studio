import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { SceneSnapshot, SceneModelState } from "@bim-studio/contracts";
import { buildDeepRuntimePackage, validateDeepRuntimePackage } from "@bim-studio/deep-engine/runtime-package";
import { Matrix4, Object3D } from "three";
import sharp from "sharp";
import { compileSceneRenderPacket } from "./compileSceneRenderPacket";

const box = readFileSync(new URL("../../../../packages/deep-engine/lab/assets/Box.glb", import.meta.url));
function materialBox(alphaMode: "MASK" | "BLEND", alphaCutoff = 0.5): Uint8Array {
  const jsonLength = box.readUInt32LE(12);
  const gltf = JSON.parse(box.subarray(20, 20 + jsonLength).toString("utf8"));
  Object.assign(gltf.materials[0], { alphaMode, alphaCutoff });
  gltf.materials[0].pbrMetallicRoughness.baseColorFactor[3] = 0.25;
  const json = Buffer.from(JSON.stringify(gltf));
  const padded = Buffer.alloc(Math.ceil(json.length / 4) * 4, 0x20); json.copy(padded);
  const rest = box.subarray(20 + jsonLength);
  const header = Buffer.alloc(20); box.copy(header, 0, 0, 20);
  header.writeUInt32LE(20 + padded.length + rest.length, 8); header.writeUInt32LE(padded.length, 12);
  return Buffer.concat([header, padded, rest]);
}
function model(modelId: string, assetModelId = "box"): SceneModelState {
  return { modelId, assetModelId, name: modelId, visible: true, opacity: 1,
    transform: { position: { x: 3, y: 4, z: 5 }, rotation: { x: 0.2, y: 0.3, z: 0.4 }, scale: { x: 2, y: 3, z: 4 } } };
}
function scene(models: SceneModelState[]): SceneSnapshot {
  return { schemaVersion: 1, id: "scene", projectId: "project", name: "fixture", models, primitives: [], measurements: [],
    camera: { mode: "orbit", position: { x: 0, y: 2, z: 5 }, target: { x: 0, y: 0, z: 0 } }, createdAt: "", updatedAt: "" };
}

describe("saved scene GLB compilation", () => {
  it.each(["scale", "rotation"])("rejects internal GLB large vertices with %s precision loss", async kind => {
    const bytes = Buffer.from(box), jsonLength = bytes.readUInt32LE(12);
    const gltf = JSON.parse(bytes.subarray(20, 20 + jsonLength).toString("utf8"));
    const accessor = gltf.accessors[gltf.meshes[0].primitives[0].attributes.POSITION];
    const view = gltf.bufferViews[accessor.bufferView];
    const start = 20 + jsonLength + 8 + (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
    for (let index = 0; index < accessor.count; index++) bytes.writeFloatLE(kind === "scale" ? 1e8 : 1e6, start + index * (view.byteStride ?? 12));
    const object = model("internal-large");
    object.transform = { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: kind === "rotation" ? Math.PI / 4 : 0 }, scale: { x: kind === "scale" ? 1.0000001 : 1, y: 1, z: 1 } };
    await expect(compileSceneRenderPacket(scene([object]), { loadModel: async () => bytes }))
      .rejects.toThrow(/models\[internal-large\].*无法在当前局部坐标精度预算内验证/);
  });
  it("rejects translation precision loss in the final composed instance matrix", async () => {
    const object = model("large"); object.transform.position.x = 1e6 + 0.01;
    await expect(compileSceneRenderPacket(scene([object]), { loadModel: async () => box }))
      .rejects.toThrow(/models\[large\].instances\[.*\].position.x.*Float32 误差/);
  });
  it.each([0.999, 1])("preserves authored alpha test at model opacity %s", async opacity => {
    const result = await compileSceneRenderPacket(scene([{ ...model("mask"), opacity }]), { loadModel: async () => materialBox("MASK", 0.35) });
    expect(result.packet.materials[0]).toMatchObject({ alphaMode: "MASK", alphaCutoff: 0.35, baseColorAlpha: opacity });
    const runtime = buildDeepRuntimePackage({ packageId: "mask.scene", packageVersion: "1.0.0",
      renderPacket: { id: "scene", revision: 1, value: result.packet } });
    expect(validateDeepRuntimePackage(JSON.parse(JSON.stringify(runtime))).valid).toBe(true);
  });
  it("refuses alpha-test plus blending until the target represents both operations", async () => {
    await expect(compileSceneRenderPacket(scene([{ ...model("mask"), opacity: 0.5 }]), {
      loadModel: async () => materialBox("MASK"),
    })).rejects.toThrow(/镂空材质与半透明/);
  });
  it("allows a disabled alpha test and keeps opaque overrides of blended source material", async () => {
    const transparent = await compileSceneRenderPacket(scene([{ ...model("mask"), opacity: 0.5 }]), {
      loadModel: async () => materialBox("MASK", 0),
    });
    expect(transparent.packet.materials[0]).toMatchObject({ alphaMode: "BLEND", baseColorAlpha: 0.5 });
    const opaque = await compileSceneRenderPacket(scene([model("blend")]), { loadModel: async () => materialBox("BLEND") });
    expect(opaque.packet.materials[0]).toMatchObject({ alphaMode: "OPAQUE", baseColorAlpha: 1 });
  });
  it("embeds decoded texture pixels with independent asset namespaces", async () => {
    const textured = readFileSync(new URL("../../../../packages/deep-engine/lab/assets/BoxTextured.glb", import.meta.url));
    const decode = vi.fn(async (image: { data: Uint8Array }) => {
      const decoded = await sharp(image.data).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      return { width: decoded.info.width, height: decoded.info.height, data: new Uint8Array(decoded.data) };
    });
    const result = await compileSceneRenderPacket(scene([model("one", "asset-a"), model("two", "asset-b")]), {
      loadModel: async () => textured, imageDecoder: { decode },
    });
    expect(decode).toHaveBeenCalledTimes(2);
    expect(result.packet.textures).toHaveLength(2);
    expect(new Set(result.packet.textures!.map(texture => texture.id)).size).toBe(2);
    expect(new Set(result.packet.geometries.map(geometry => geometry.id)).size).toBe(2);
    for (const material of result.packet.materials) {
      expect(result.packet.textures!.some(texture => texture.id === material.baseColorTexture?.texture)).toBe(true);
    }
    const runtime = buildDeepRuntimePackage({ packageId: "textured.scene", packageVersion: "1.0.0",
      renderPacket: { id: "scene", revision: 1, value: result.packet } });
    expect(validateDeepRuntimePackage(JSON.parse(JSON.stringify(runtime))).valid).toBe(true);
  }, 30_000);

  it("decodes a shared asset once and preserves instance identities and root transforms", async () => {
    const loadModel = vi.fn(async () => box), input = scene([model("second"), model("first")]);
    const compiled = await compileSceneRenderPacket(input, { loadModel });
    expect(loadModel).toHaveBeenCalledTimes(1);
    expect(compiled.sourceBytes).toBe(box.byteLength);
    expect(compiled.packet.geometries).toHaveLength(1);
    expect(compiled.packet.instances).toHaveLength(2);
    expect(compiled.objectBindings.map(item => item.nodeId)).toEqual(["first", "second"]);
    expect(new Set(compiled.objectBindings.flatMap(item => item.instanceIds)).size).toBe(2);
    const author = new Object3D(), state = input.models[0]!.transform;
    author.position.set(state.position.x, state.position.y, state.position.z);
    author.rotation.set(state.rotation.x, state.rotation.y, state.rotation.z);
    author.scale.set(state.scale.x, state.scale.y, state.scale.z); author.updateMatrixWorld(true);
    const expected = author.matrixWorld.clone().multiply(new Matrix4().fromArray([1,0,0,0,0,0,-1,0,0,1,0,0,0,0,0,1]));
    Array.from(compiled.packet.instances[0]!.transform).forEach((value, i) => expect(value).toBeCloseTo(expected.elements[i]!, 5));
    const runtime = buildDeepRuntimePackage({ packageId: "compiled.scene", packageVersion: "1.0.0",
      renderPacket: { id: "scene", revision: 1, value: compiled.packet } });
    expect(validateDeepRuntimePackage(JSON.parse(JSON.stringify(runtime))).valid).toBe(true);
    const reordered = await compileSceneRenderPacket({ ...input, models: [...input.models].reverse() }, { loadModel });
    expect(reordered).toEqual(compiled);
  });

  it("keeps model material overrides isolated and does not fetch hidden assets", async () => {
    const loadModel = vi.fn(async () => box);
    const compiled = await compileSceneRenderPacket(scene([
      { ...model("hidden", "missing"), visible: false }, model("one"),
      { ...model("two"), opacity: 0.4, colorOverride: "#808080" },
    ]), { loadModel });
    expect(loadModel).toHaveBeenCalledTimes(1);
    expect(compiled.objectBindings[0]).toEqual({ nodeId: "hidden", instanceIds: [] });
    expect(compiled.packet.materials[0]!.baseColor[0]).toBeCloseTo(0.8);
    expect(compiled.packet.materials[1]).toMatchObject({ baseColorAlpha: 0.4, alphaMode: "BLEND" });
    expect(compiled.packet.materials[1]!.baseColor[0]).toBeCloseTo(0.2158605, 6);
  });

  it("snapshots author state before asynchronous resource loading", async () => {
    const input = scene([model("one")]);
    const loadModel = async () => { input.models[0]!.transform.position.x = 999; input.models.push(model("late")); return box; };
    const compiled = await compileSceneRenderPacket(input, { loadModel });
    expect(compiled.packet.instances).toHaveLength(1);
    expect(compiled.packet.instances[0]!.transform[12]).toBe(3);
  });

  it("propagates cancellation even when a resource loader ignores it", async () => {
    const controller = new AbortController(), loadModel = vi.fn(async () => { controller.abort(); return box; });
    await expect(compileSceneRenderPacket(scene([model("one")]), { loadModel, signal: controller.signal })).rejects.toThrow();
    expect(loadModel).toHaveBeenCalledTimes(1);
    await expect(compileSceneRenderPacket(scene([model("one")]), { loadModel, signal: controller.signal })).rejects.toThrow();
    expect(loadModel).toHaveBeenCalledTimes(1);
  });

  it("rejects duplicate identities before IO and refuses malformed or over-budget assets", async () => {
    const loadModel = vi.fn(async () => box);
    await expect(compileSceneRenderPacket(scene([model("one"), model("one")]), { loadModel })).rejects.toThrow(/ID/);
    expect(loadModel).not.toHaveBeenCalled();
    await expect(compileSceneRenderPacket(scene([model("one")]), { loadModel, maxSourceBytes: 1 })).rejects.toThrow(/预算/);
    await expect(compileSceneRenderPacket(scene([model("one")]), { loadModel: async () => new Uint8Array(20) })).rejects.toThrow();
    await expect(compileSceneRenderPacket(scene([{ ...model("one"), material: { wireframe: true } }]), { loadModel })).rejects.toThrow(/扩展外观/);
  });
});
