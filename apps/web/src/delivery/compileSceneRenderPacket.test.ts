import { sourceMaterialPatch } from "../viewer/sourceMaterialReset";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { PrimitiveState, SceneSnapshot, SceneModelState } from "@bim-studio/contracts";
import { buildDeepRuntimePackage, validateDeepRuntimePackage } from "@bim-studio/deep-engine/runtime-package";
import { Color, Matrix4, Object3D } from "three";
import sharp from "sharp";
import { compileSceneRenderPacket } from "./compileSceneRenderPacket";
import { decodeAuthorModel, type AuthorModelDecoder } from "./authorModelDecode";
import { describeDeepCompileNotice } from "./deepCompileNotice";

const box = readFileSync(new URL("../../../../packages/deep-engine/lab/assets/Box.glb", import.meta.url));
function materialBox(alphaMode: "MASK" | "BLEND", alphaCutoff = 0.5, transmission?: number): Uint8Array {
  const jsonLength = box.readUInt32LE(12);
  const gltf = JSON.parse(box.subarray(20, 20 + jsonLength).toString("utf8"));
  Object.assign(gltf.materials[0], { alphaMode, alphaCutoff });
  gltf.materials[0].pbrMetallicRoughness.baseColorFactor[3] = 0.25;
  if (transmission !== undefined) {
    gltf.extensionsUsed = ["KHR_materials_transmission"];
    gltf.materials[0].extensions = { KHR_materials_transmission: { transmissionFactor: transmission } };
  }
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
  it("lets a presenting host own the grid without dropping model resources", async () => {
    const source: SceneSnapshot = { ...scene([model("one")]), environment: { gridVisible: true, skybox: "studio", backgroundColor: "#17272e" } };
    const options = { loadModel: async () => box };
    const published = await compileSceneRenderPacket(source, options);
    const hosted = await compileSceneRenderPacket(source, { ...options, includeAuxiliaryGrid: false });
    expect(published.packet.instances.some(instance => instance.id.startsWith("scene.auxiliary-grid."))).toBe(true);
    expect(hosted.packet.instances.some(instance => instance.id.startsWith("scene.auxiliary-grid."))).toBe(false);
    expect(hosted.packet.instances).toEqual(published.packet.instances.filter(instance => !instance.id.startsWith("scene.auxiliary-grid.")));
    expect(hosted.packet.textures ?? []).toEqual(published.packet.textures?.filter(texture => !texture.id.startsWith("scene.auxiliary-grid.")));
  });
  it("shares only static decoded assets across live/static hosts and separates decode profiles", async () => {
    const decodedAssetCache = new Map(), normalizeModel = vi.fn(async (bytes: Uint8Array) => bytes);
    const source = scene([model("one")]);
    const live = await compileSceneRenderPacket(source, { loadModel: async () => box, normalizeModel,
      liveDeformation: true, advancedMaterials: true, textureBudgetBytes: 112 * 1024 * 1024, decodedAssetCache });
    const frozen = await compileSceneRenderPacket(source, { loadModel: async () => box, normalizeModel,
      advancedMaterials: true, textureBudgetBytes: 112 * 1024 * 1024, decodedAssetCache });
    expect(frozen.packet).toEqual(live.packet); expect(normalizeModel).toHaveBeenCalledOnce();
    await compileSceneRenderPacket(source, { loadModel: async () => box, normalizeModel,
      advancedMaterials: true, textureBudgetBytes: 8 * 1024 * 1024, decodedAssetCache });
    expect(normalizeModel).toHaveBeenCalledTimes(2);
    await compileSceneRenderPacket(source, { loadModel: async () => box, normalizeModel,
      advancedMaterials: false, textureBudgetBytes: 112 * 1024 * 1024, decodedAssetCache });
    expect(normalizeModel).toHaveBeenCalledTimes(3);
  });
  it("reuses a decoded asset across author edits without duplicating resource or deformation IDs", async () => {
    const decodedAssetCache = new Map();
    const first = await compileSceneRenderPacket(scene([model("one")]), { loadModel: async () => box, decodedAssetCache });
    const edited = { ...model("one"), colorOverride: "#ff0000" };
    const warm = await compileSceneRenderPacket(scene([edited]), { loadModel: async () => box, decodedAssetCache });
    const cold = await compileSceneRenderPacket(scene([edited]), { loadModel: async () => box });
    expect(warm).toEqual(cold);
    expect(warm.packet.geometries).toHaveLength(first.packet.geometries.length);
    expect(new Set(warm.packet.geometries.map(geometry => geometry.id)).size).toBe(warm.packet.geometries.length);
  });
  it("binds every procedural road part to one author object without asset IO", async () => {
    const road = { modelId: "road", name: "Road", kind: "box", visible: true, opacity: 1, color: "#808080",
      transform: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } },
      prefab: { definitionId: "road.straight", definitionVersion: "1.0.0", kind: "road", operatingState: "idle",
        parameters: { lengthM: 20, carriagewayWidthM: 7, laneCount: 2, shoulderWidthM: 0.75, surface: "asphalt", marking: "center" },
        placementPath: { points: [{ id: "a", position: { x: 0, y: 0, z: 0 } },
          { id: "b", position: { x: 12, y: 0, z: 3 } }], interpolation: "linear", closed: false,
          snapToGround: false, seed: 9 } } } satisfies PrimitiveState;
    const loadModel = vi.fn(async () => box);
    const result = await compileSceneRenderPacket({ ...scene([]), primitives: [road] }, { loadModel });
    expect(loadModel).not.toHaveBeenCalled();
    expect(result.objectBindings).toEqual([{ nodeId: "road", instanceIds: result.packet.instances.map(instance => instance.id) }]);
    expect(result.objectBindings[0]!.instanceIds.length).toBeGreaterThan(0);
    // 节点级拾取映射随包透传;builder 负责把它提升到运行包顶层。
    expect(result.packet.objectBindings).toEqual([{ nodeId: "road", instanceIds: result.packet.instances.map(instance => instance.id) }]);
  });

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
    expect(result.packet.materials[0]).toMatchObject({ alphaMode: "MASK", alphaCutoff: 0.35, baseColorAlpha: 0.25 * opacity });
    const runtime = buildDeepRuntimePackage({ packageId: "mask.scene", packageVersion: "1.0.0",
      renderPacket: { id: "scene", revision: 1, value: result.packet } });
    expect(validateDeepRuntimePackage(JSON.parse(JSON.stringify(runtime))).valid).toBe(true);
  });
  it("refuses alpha-test plus blending until the target represents both operations", async () => {
    await expect(compileSceneRenderPacket(scene([{ ...model("mask"), opacity: 0.5 }]), {
      loadModel: async () => materialBox("MASK"),
    })).rejects.toThrow(/镂空材质与半透明/);
  });
  it("allows a disabled alpha test while multiplying its source alpha", async () => {
    const transparent = await compileSceneRenderPacket(scene([{ ...model("mask"), opacity: 0.5 }]), {
      loadModel: async () => materialBox("MASK", 0),
    });
    expect(transparent.packet.materials[0]).toMatchObject({ alphaMode: "BLEND", baseColorAlpha: 0.125 });
  });
  it.each([1, 0.5, 0])("preserves imported BLEND and applies scene opacity %s once", async opacity => {
    const result = await compileSceneRenderPacket(scene([{ ...model("glass"), opacity }]), {
      loadModel: async () => materialBox("BLEND"),
    });
    expect(result.packet.materials[0]).toMatchObject({ alphaMode: "BLEND", baseColorAlpha: 0.25 * opacity });
  });
  it("preserves source alpha while applying explicit instance and slot material edits", async () => {
    const result = await compileSceneRenderPacket(scene([{ ...model("glass"), opacity: 0.5,
      colorOverride: "#ffffff", material: { roughness: 0.7,
        slotOverrides: { "gltf:0": { color: "#808080", roughness: 0.2, transmission: 0.8 } } },
    }]), { loadModel: async () => materialBox("BLEND") });
    expect(result.packet.materials[0]).toMatchObject({ alphaMode: "BLEND", baseColorAlpha: 0.125,
      roughness: 0.2, extendedParameters: { transmission: { factor: 0.8 } } });
    expect(result.packet.materials[0]!.baseColor).toEqual(new Color("#808080").toArray());
  });
  it("retains untextured imported transmission through the worker decode boundary", async () => {
    const bytes = materialBox("BLEND", 0.5, 1);
    const decode = vi.fn(async () => { throw new Error("glass has no texture"); });
    const decodeModel = vi.fn(async (...[source, settings, signal]: Parameters<AuthorModelDecoder>) =>
      decodeAuthorModel(source, settings, signal, async value => value, { decode }));
    const result = await compileSceneRenderPacket(scene([model("glass")]), {
      loadModel: async () => bytes, advancedMaterials: true, decodeModel,
    });
    expect(decodeModel.mock.calls[0]![1]).toMatchObject({ advancedMaterials: true });
    expect(result.packet.materials[0]).toMatchObject({ alphaMode: "BLEND", baseColorAlpha: 0.25,
      extendedParameters: { transmission: { factor: 1 } } });
    expect(result.materialLosses).toBeUndefined();
    expect(decode).not.toHaveBeenCalled();
  });
  it("keeps unsupported source material losses visible per placement", async () => {
    const result = await compileSceneRenderPacket(scene([model("a"), model("b")]), {
      loadModel: async () => materialBox("BLEND", 0.5, 1),
    });
    expect(result.materialLosses?.map(loss => loss.modelId)).toEqual(["a", "b"]);
    expect(result.materialLosses?.[0]?.loss.code).toBe("material-profile-unsupported");
    expect(describeDeepCompileNotice(result)).toContain("2 个对象存在材质降级");
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
    // compilation.objectBindings 保留"每对象一条"语义;进包映射只带非空绑定(不可见对象无实例可命中)。
    expect(compiled.packet.objectBindings).toEqual([{ nodeId: "one", instanceIds: expect.any(Array) }, { nodeId: "two", instanceIds: expect.any(Array) }]);
    expect(compiled.packet.objectBindings!.find(item => item.nodeId === "two")!.instanceIds.length).toBeGreaterThan(0);
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

  it("omits packet objectBindings when the scene has no author objects", async () => {
    const result = await compileSceneRenderPacket(scene([]), { loadModel: vi.fn(async () => box) });
    expect(result.objectBindings).toEqual([]);
    expect(result.packet.objectBindings).toBeUndefined();
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


describe("authored material publication", () => {
  it("projects saved glow and edge-light to the same HDR emissive contract as the Web viewer", async () => {
    const effects = { outline: false, glow: true, xray: false, scanline: false, heatmap: false,
      dissolve: 0, edgeLight: true, color: "#f4c76b", intensity: 0.52 };
    const result = await compileSceneRenderPacket(scene([{ ...model("effect"), effects }]), { loadModel: async () => box });
    const material = result.packet.materials[0]!;
    expect(material.emissiveFactor).toEqual(new Color("#f4c76b").toArray());
    expect(material.emissiveStrength).toBeCloseTo(0.728, 6);
    const outlined = await compileSceneRenderPacket(scene([{ ...model("outline"), effects: { ...effects, outline: true } }]),
      { loadModel: async () => box });
    expect(outlined.packet.instances.every(instance => instance.outline === true)).toBe(true);
  });

  it("preserves saved PBR overrides per instance through the runtime package", async () => {
    const authored = { ...model("painted"), colorOverride: "#ffffff", material: {
      color: "#808080", roughness: 0.23, metalness: 0.74,
      emissive: "#804020", emissiveIntensity: 3.5, doubleSided: true,
    } };
    const saved = JSON.parse(JSON.stringify(scene([authored, model("original")])));
    const result = await compileSceneRenderPacket(saved, { loadModel: async () => box });
    const binding = result.objectBindings.find(item => item.nodeId === "painted")!;
    const instance = result.packet.instances.find(item => item.id === binding.instanceIds[0])!;
    const material = result.packet.materials.find(item => item.id === instance.material)!;
    const gray = new Color("#808080");
    expect(material).toMatchObject({ baseColor: [gray.r, gray.g, gray.b], roughness: 0.23, metallic: 0.74,
      emissiveStrength: 3.5, doubleSided: true });
    expect(material.emissiveFactor).toEqual(new Color("#804020").toArray());
    const other = result.packet.materials.find(item => item.id !== material.id)!;
    expect(other.roughness).not.toBe(0.23);
    const runtime = buildDeepRuntimePackage({ packageId: "material.scene", packageVersion: "1.0.0",
      renderPacket: { id: "scene", revision: 1, value: result.packet } });
    expect(validateDeepRuntimePackage(JSON.parse(JSON.stringify(runtime))).valid).toBe(true);
    const restored = await compileSceneRenderPacket(scene([model("painted")]), { loadModel: async () => box });
    expect(restored.packet.materials[0]!.roughness).toBe(other.roughness);
  });
  it("continues refusing unsupported authored maps and non-finite values", async () => {
    await expect(compileSceneRenderPacket(scene([{ ...model("map"), material: { normalMapUrl: "/normal.png" } }]),
      { loadModel: async () => box })).rejects.toThrow(/normalMapUrl/);
    await expect(compileSceneRenderPacket(scene([{ ...model("bad"), material: { roughness: NaN } }]),
      { loadModel: async () => box })).rejects.toThrow(/有限数值/);
  });
});


describe("source material slot publication", () => {
  it("round-trips an isolated override among two identically named material slots", async () => {
    const jsonLength = box.readUInt32LE(12);
    const gltf = JSON.parse(box.subarray(20, 20 + jsonLength).toString("utf8"));
    gltf.materials[0].name = "Paint";
    gltf.materials.push(structuredClone(gltf.materials[0]));
    gltf.meshes[0].primitives.push({ ...gltf.meshes[0].primitives[0], material: 1 });
    const json = Buffer.from(JSON.stringify(gltf));
    const padded = Buffer.alloc(Math.ceil(json.length / 4) * 4, 0x20); json.copy(padded);
    const rest = box.subarray(20 + jsonLength), header = Buffer.from(box.subarray(0, 20));
    header.writeUInt32LE(20 + padded.length + rest.length, 8); header.writeUInt32LE(padded.length, 12);
    const bytes = Buffer.concat([header, padded, rest]);
    const saved = JSON.parse(JSON.stringify(scene([{ ...model("a"), material: {
      roughness: 0.8, slotOverrides: { "gltf:1": { roughness: 0.15, metalness: 0.9 } },
    } }, model("b")])));
    const result = await compileSceneRenderPacket(saved, { loadModel: async () => bytes });
    const aIds = result.objectBindings.find(item => item.nodeId === "a")!.instanceIds;
    const aMaterials = result.packet.instances.filter(item => aIds.includes(item.id))
      .map(instance => result.packet.materials.find(material => material.id === instance.material)!);
    expect(aMaterials.find(material => material.id.endsWith("/material/0"))!.roughness).toBe(0.8);
    expect(aMaterials.find(material => material.id.endsWith("/material/1"))).toMatchObject({ roughness: 0.15, metallic: 0.9 });
    expect(result.packet.materials.filter(material => !aMaterials.includes(material)).every(material => material.roughness !== 0.15)).toBe(true);
    const runtime = buildDeepRuntimePackage({ packageId: "slots.scene", packageVersion: "1.0.0",
      renderPacket: { id: "scene", revision: 1, value: result.packet } });
    expect(validateDeepRuntimePackage(JSON.parse(JSON.stringify(runtime))).valid).toBe(true);
  });
  it("rejects stale source slots instead of silently publishing the wrong surface", async () => {
    await expect(compileSceneRenderPacket(scene([{ ...model("a"), material: {
      slotOverrides: { "gltf:999": { roughness: 0.2 } },
    } }]), { loadModel: async () => box })).rejects.toThrow(/材质槽不在源资源/);
  });
});


it("publishes restored source textures and scalar slot values after save/reload", async () => {
  const original = await compileSceneRenderPacket(scene([model("a")]), { loadModel: async () => box });
  const restored = { ...model("a"), material: { slotOverrides: { "gltf:0": sourceMaterialPatch({ roughness: original.packet.materials[0]!.roughness }) } } };
  const result = await compileSceneRenderPacket(JSON.parse(JSON.stringify(scene([restored]))), { loadModel: async () => box });
  expect(result.packet.materials[0]).toMatchObject(original.packet.materials[0]!);
});


describe("author texture overrides on the Deep native chain", () => {
  const decode = async (image: { data: Uint8Array }) => {
    const decoded = await sharp(image.data).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    return { width: decoded.info.width, height: decoded.info.height, data: new Uint8Array(decoded.data) };
  };
  const png = async (size: number, red: number): Promise<Uint8Array<ArrayBuffer>> =>
    new Uint8Array(await sharp({ create: { width: size, height: size, channels: 4,
      background: { r: red, g: 30, b: 40, alpha: 1 } } }).png().toBuffer());
  const loadTextureOf = (loadTexture: (url: string) => Promise<Uint8Array<ArrayBuffer>>) =>
    ({ loadTexture: async (url: string, signal: AbortSignal) => { signal.throwIfAborted(); return loadTexture(url); } });

  /** BoxTextured 剥掉源纹理引用:TEXCOORD_0 保留,材质变为无源纹理(作者贴图覆盖的主战场)。 */
  function uvCarryingGlbWithoutSourceTextures(): Buffer {
    const bytes = readFileSync(new URL("../../../../packages/deep-engine/lab/assets/BoxTextured.glb", import.meta.url));
    const jsonLength = bytes.readUInt32LE(12);
    const gltf = JSON.parse(bytes.subarray(20, 20 + jsonLength).toString("utf8"));
    for (const material of gltf.materials) delete material.pbrMetallicRoughness.baseColorTexture;
    const json = Buffer.from(JSON.stringify(gltf));
    const padded = Buffer.alloc(Math.ceil(json.length / 4) * 4, 0x20); json.copy(padded);
    const rest = bytes.subarray(20 + jsonLength), header = Buffer.from(bytes.subarray(0, 20));
    header.writeUInt32LE(20 + padded.length + rest.length, 8); header.writeUInt32LE(padded.length, 12);
    return Buffer.concat([header, padded, rest]);
  }
  const uvGlb = uvCarryingGlbWithoutSourceTextures();

  it("wires the five author map slots into the native packet", async () => {
    const loadTexture = vi.fn(async (url: string) => {
      if (url.endsWith("base.png")) return png(8, 200);
      if (url.endsWith("normal.png")) return png(8, 30);
      if (url.endsWith("ao.png")) return png(8, 60);
      if (url.endsWith("rough.png")) return png(8, 90);
      throw new Error(`unexpected texture ${url}`);
    });
    const result = await compileSceneRenderPacket(scene([{ ...model("pbr"), material: {
      baseColorMapUrl: "/t/base.png", normalMapUrl: "/t/normal.png", ambientOcclusionMapUrl: "/t/ao.png",
      roughnessMapUrl: "/t/rough.png", metalnessMapUrl: "/t/rough.png", normalScale: 2,
      textureRepeatX: 2, textureRepeatY: 2,
    } }]), { loadModel: async () => uvGlb, imageDecoder: { decode }, textureBudgetBytes: 112 * 1024 * 1024,
      ...loadTextureOf(loadTexture) });
    const material = result.packet.materials[0]!;
    expect(material.baseColorTexture).toMatchObject({ scale: [2, 2], offset: [-0.5, -0.5], rotation: 0 });
    expect(material.normalTexture).toMatchObject({ normalScale: 2, scale: [2, 2], offset: [-0.5, -0.5] });
    expect(material.occlusionTexture).toMatchObject({ strength: 1 });
    expect(material.metallicRoughnessTexture).toBeDefined();
    expect(new Set(result.packet.textures!.map(texture => texture.semantic)))
      .toEqual(new Set(["baseColor", "normal", "occlusion", "metallicRoughness"]));
    expect(result.packet.textures!.find(texture => texture.semantic === "baseColor")!.width).toBe(8);
    // 源包无 TANGENT:切线按 N5 先例生成,无损失记录。
    const geometry = result.packet.geometries[0]!;
    expect(geometry.tangents).toHaveLength(geometry.vertices.length / 6 * 4);
    expect(result.textureLosses).toBeUndefined();
    const runtime = buildDeepRuntimePackage({ packageId: "author-textures.scene", packageVersion: "1.0.0",
      renderPacket: { id: "scene", revision: 1, value: result.packet } });
    expect(validateDeepRuntimePackage(JSON.parse(JSON.stringify(runtime))).valid).toBe(true);
    // 同 URL 只取一次字节(MR 双槽共享解码)。
    expect(loadTexture).toHaveBeenCalledTimes(4);
  }, 30_000);

  it("still refuses non-whitelisted appearance extensions with a loader present", async () => {
    const options = { loadModel: async () => box, imageDecoder: { decode },
      textureBudgetBytes: 112 * 1024 * 1024, ...loadTextureOf(async () => png(4, 1)) };
    await expect(compileSceneRenderPacket(scene([{ ...model("emissive"), material: {
      emissiveMapUrl: "/t/e.png" } }]), options)).rejects.toThrow(/emissiveMapUrl/);
    await expect(compileSceneRenderPacket(scene([{ ...model("uv"), material: {
      baseColorMapUrl: "/t/b.png", uvAnimation: { enabled: true, offsetSpeedX: 1, offsetSpeedY: 0, rotationSpeed: 0 } } }]),
      options)).rejects.toThrow(/uvAnimation/);
  });

  it("fail-closes UV0-less geometry to the projection fallback", async () => {
    // Box.glb 源无 TEXCOORD:任何渲染器都无法映射贴图,按 SceneAppearanceUnsupported 交回投影路径。
    await expect(compileSceneRenderPacket(scene([{ ...model("nouv"), material: { baseColorMapUrl: "/t/base.png" } }]), {
      loadModel: async () => box, imageDecoder: { decode }, textureBudgetBytes: 112 * 1024 * 1024,
      ...loadTextureOf(async () => png(4, 1)),
    })).rejects.toThrow(/材质贴图需要 UV0/);
  });

  it("fail-closes author textures over the decode budget", async () => {
    await expect(compileSceneRenderPacket(scene([{ ...model("big"), material: { baseColorMapUrl: "/t/base.png" } }]), {
      loadModel: async () => uvGlb, imageDecoder: { decode }, textureBudgetBytes: 8,
      ...loadTextureOf(async () => png(64, 1)),
    })).rejects.toThrow(/超出 Deep 纹理解码预算/);
  });

  it("applies slot-scoped texture overrides to the targeted source slot only", async () => {
    const jsonLength = uvGlb.readUInt32LE(12);
    const gltf = JSON.parse(uvGlb.subarray(20, 20 + jsonLength).toString("utf8"));
    gltf.materials.push(structuredClone(gltf.materials[0]));
    gltf.meshes[0].primitives.push({ ...gltf.meshes[0].primitives[0], material: 1 });
    const json = Buffer.from(JSON.stringify(gltf));
    const padded = Buffer.alloc(Math.ceil(json.length / 4) * 4, 0x20); json.copy(padded);
    const rest = uvGlb.subarray(20 + jsonLength), header = Buffer.from(uvGlb.subarray(0, 20));
    header.writeUInt32LE(20 + padded.length + rest.length, 8); header.writeUInt32LE(padded.length, 12);
    const bytes = Buffer.concat([header, padded, rest]);
    const result = await compileSceneRenderPacket(scene([{ ...model("slotted"), material: {
      slotOverrides: { "gltf:1": { baseColorMapUrl: "/t/slot.png" } } } }]),
      { loadModel: async () => bytes, imageDecoder: { decode }, textureBudgetBytes: 112 * 1024 * 1024,
        ...loadTextureOf(async () => png(4, 7)) });
    const materialBySlot = (slot: string) => result.packet.materials.find(material => material.id.endsWith(`/material/${slot}`))!;
    expect(materialBySlot("0").baseColorTexture).toBeUndefined();
    expect(materialBySlot("1").baseColorTexture).toBeDefined();
    expect(result.packet.textures).toHaveLength(1);
  }, 30_000);
});
