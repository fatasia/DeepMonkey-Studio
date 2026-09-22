import { describe, expect, it } from "vitest";
import { Color, Mesh, Vector3 } from "three";
import type { PrimitiveKind, PrimitiveState, SceneSnapshot } from "@bim-studio/contracts";
import { buildDeepRuntimePackage, validateDeepRuntimePackage } from "@bim-studio/deep-engine/runtime-package";
import { sceneSnapshotToRenderPacket } from "./sceneSnapshotRenderPacket";

const kinds: PrimitiveKind[] = ["box", "sphere", "cylinder", "cone", "torus", "plane", "capsule"];
function primitive(id = "one", kind: PrimitiveKind = "box"): PrimitiveState {
  return { modelId: id, name: id, kind, visible: true, opacity: 1, color: "#808080",
    transform: { position: { x: 3, y: -2, z: 8 }, rotation: { x: 0.4, y: -0.7, z: 0.2 }, scale: { x: 2, y: 3, z: -4 } } };
}
function scene(primitives: PrimitiveState[]): SceneSnapshot {
  return { schemaVersion: 1, id: "scene", projectId: "project", name: "test", models: [], primitives,
    camera: { mode: "orbit", position: { x: 0, y: 2, z: 5 }, target: { x: 0, y: 0, z: 0 } },
    measurements: [], createdAt: "2026-09-15T00:00:00Z", updatedAt: "2026-09-15T00:00:00Z" };
}

describe("snapshot primitive render projection", () => {
  it("accepts saved neutral material and disabled effect defaults without changing the packet", () => {
    const item = primitive();
    const defaults = { ...item, material: { hue: 0, saturation: 0, brightness: 0, contrast: 0, normalScale: 1, wireframe: false },
      effects: { outline: false, glow: false, xray: false, scanline: false, heatmap: false, edgeLight: false,
        dissolve: 0, intensity: 1, color: "#36a3ff" } };
    expect(sceneSnapshotToRenderPacket(scene([defaults]))).toEqual(sceneSnapshotToRenderPacket(scene([item])));
    for (const material of [{ hue: 1 }, { saturation: 0.1 }, { brightness: 0.1 }, { contrast: 0.1 }, { wireframe: true }]) {
      expect(() => sceneSnapshotToRenderPacket(scene([{ ...item, material }]))).toThrow(/材质需要适配/);
    }
    const outlined = sceneSnapshotToRenderPacket(scene([{ ...defaults,
      effects: { ...defaults.effects, glow: true, outline: true, edgeLight: true } }]));
    expect(outlined.instances[0]!.outline).toBe(true);
    const effect = sceneSnapshotToRenderPacket(scene([{ ...defaults,
      effects: { ...defaults.effects, glow: true, edgeLight: true, color: "#f4c76b", intensity: 0.52 } }])).materials[0]!;
    expect(effect.emissiveFactor).toEqual(new Color("#f4c76b").toArray());
    expect(effect.emissiveStrength).toBeCloseTo(0.728, 6);
  });

  it("rejects a large primitive scale even with a precisely represented root position", () => {
    const item = primitive("large"); item.transform.position = { x: 0, y: 0, z: 0 };
    item.transform.rotation = { x: 0, y: 0, z: 0 }; item.transform.scale = { x: 1e8 + 0.25, y: 1, z: 1 };
    expect(() => sceneSnapshotToRenderPacket(scene([item]))).toThrow(/primitives\[large\].*无法在当前局部坐标精度预算内验证/);
  });
  it.each(kinds)("builds a validated runtime package for %s with normals and UVs", kind => {
    const packet = sceneSnapshotToRenderPacket(scene([primitive("one", kind)]));
    const geometry = packet.geometries[0]!;
    expect(geometry.uv0?.length).toBe(geometry.vertices.length / 3);
    expect(geometry.indices.length).toBeGreaterThan(0);
    for (let i = 0; i < geometry.vertices.length; i += 6) {
      expect(Math.hypot(...geometry.vertices.slice(i + 3, i + 6))).toBeCloseTo(1, 5);
    }
    const value = buildDeepRuntimePackage({ packageId: "snapshot.fixture", packageVersion: "1.0.0",
      renderPacket: { id: "scene", revision: 1, value: packet } });
    expect(validateDeepRuntimePackage(JSON.parse(JSON.stringify(value))).valid).toBe(true);
  });

  it("has outward box winding and per-face normals", () => {
    const geometry = sceneSnapshotToRenderPacket(scene([primitive()])).geometries[0]!;
    const position = (i: number) => new Vector3().fromArray(geometry.vertices, i * 6);
    expect(geometry.vertices.length / 6).toBe(24);
    for (let i = 0; i < geometry.indices.length; i += 3) {
      const a = geometry.indices[i]!, b = geometry.indices[i + 1]!, c = geometry.indices[i + 2]!;
      const normal = position(b).sub(position(a)).cross(position(c).sub(position(a))).normalize();
      expect(normal.dot(new Vector3().fromArray(geometry.vertices, a * 6 + 3))).toBeCloseTo(1);
      expect(normal.dot(position(a))).toBeCloseTo(1);
    }
  });

  it.each(["road", "fence"] as const)("compiles a deterministic path-authored %s for Deep Web and Native", kind => {
    const item = { ...primitive(`${kind}-path`), opacity: 0.65, material: { roughness: 0.24 }, transform: { position: { x: 2, y: 0, z: 3 },
      rotation: { x: 0, y: 0.2, z: 0 }, scale: { x: 1, y: 1, z: 1 } }, prefab: {
      definitionId: kind === "road" ? "road.straight" : "fence.modular", definitionVersion: "1.0.0", kind,
      parameters: kind === "road" ? { lengthM: 20, carriagewayWidthM: 7, laneCount: 2, shoulderWidthM: 0.75,
        surface: "asphalt", marking: "center" } : { heightM: 1.8, postSpacingM: 2, gateWidthM: 1.2, panel: "mesh" },
      operatingState: "idle" as const,
      placementPath: { points: [
        { id: "a", position: { x: 0, y: 0, z: 0 } },
        { id: "b", position: { x: 8, y: 0.5, z: 0 } },
        { id: "c", position: { x: 14, y: 0, z: 6 } },
      ], interpolation: "catmull-rom" as const, closed: false, snapToGround: false, seed: 77 },
    } } satisfies PrimitiveState;
    const first = sceneSnapshotToRenderPacket(scene([item]));
    const second = sceneSnapshotToRenderPacket(scene([structuredClone(item)]));
    expect(first).toEqual(second);
    expect(first.instances.length).toBeGreaterThan(3);
    expect(first.instances.every(instance => instance.id.startsWith(`${kind}-path/prefab/part/`))).toBe(true);
    expect(first.geometries.length).toBeLessThan(first.instances.length);
    expect(first.materials.every(material => material.alphaMode === "BLEND" && material.roughness === 0.24)).toBe(true);
    const value = buildDeepRuntimePackage({ packageId: `snapshot.${kind}`, packageVersion: "1.0.0",
      renderPacket: { id: "scene", revision: 1, value: first } });
    expect(validateDeepRuntimePackage(JSON.parse(JSON.stringify(value))).valid).toBe(true);
  });

  it("matches author XYZ rotation with translation and negative nonuniform scale", () => {
    const item = primitive(), object = new Mesh(), { position: p, rotation: r, scale: s } = item.transform;
    object.position.set(p.x, p.y, p.z); object.rotation.set(r.x, r.y, r.z); object.scale.set(s.x, s.y, s.z);
    object.updateMatrixWorld(true);
    const actual = sceneSnapshotToRenderPacket(scene([item])).instances[0]!.transform;
    Array.from(actual).forEach((value, i) => expect(value).toBeCloseTo(object.matrixWorld.elements[i]!, 5));
  });

  it("omits hidden objects and shares geometry without merging distinct material states", () => {
    const hidden = { ...primitive("hidden"), visible: false };
    const transparent = { ...primitive("two"), opacity: 0.5 };
    const packet = sceneSnapshotToRenderPacket(scene([hidden, primitive(), transparent]));
    expect(packet.instances.map(value => value.id)).toEqual(["one", "two"]);
    expect(packet.geometries).toHaveLength(1);
    expect(packet.materials[0]).toMatchObject({ metallic: 0.05, roughness: 0.72, alphaMode: "OPAQUE" });
    expect(packet.materials[0]!.baseColor[0]).toBeCloseTo(0.2158605, 6);
    expect(packet.materials[1]).toMatchObject({ baseColorAlpha: 0.5, alphaMode: "BLEND" });
  });

  it("applies explicit author overrides and clamps supported PBR values", () => {
    const item = { ...primitive(), colorOverride: "#ff0000", material: { color: "#00ff00", roughness: 2,
      metalness: -1, ior: 2.4, emissive: "#0000ff", emissiveIntensity: 12, doubleSided: true } };
    expect(sceneSnapshotToRenderPacket(scene([item])).materials[0]).toMatchObject({ baseColor: [0, 1, 0],
      roughness: 1, metallic: 0, ior: 2.4, emissiveFactor: [0, 0, 1], emissiveStrength: 10, doubleSided: true });
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])("rejects invalid primitive IOR %s", ior => {
    expect(() => sceneSnapshotToRenderPacket(scene([{ ...primitive(), material: { ior } }]))).toThrow(/折射率/);
  });

  it("is deterministic for input order and does not mutate the source", () => {
    const input = scene([primitive("two", "sphere"), primitive("one")]), before = structuredClone(input);
    const first = sceneSnapshotToRenderPacket(input);
    expect(input).toEqual(before);
    expect(sceneSnapshotToRenderPacket({ ...input, primitives: [...input.primitives].reverse() })).toEqual(first);
    first.geometries[0]!.vertices[0] = 999;
    expect(sceneSnapshotToRenderPacket(input).geometries[0]!.vertices[0]).not.toBe(999);
    expect(sceneSnapshotToRenderPacket(scene([]))).toEqual({ geometries: [], materials: [], instances: [] });
  });

  it("rejects duplicate IDs, invalid values and unadapted assets rather than losing objects", () => {
    expect(() => sceneSnapshotToRenderPacket(scene([primitive(), primitive()]))).toThrow(/ID/);
    expect(() => sceneSnapshotToRenderPacket(scene([{ ...primitive(), color: "bad" }]))).toThrow(/颜色/);
    expect(() => sceneSnapshotToRenderPacket(scene([{ ...primitive(), opacity: 2 }]))).toThrow(/透明度/);
    const invalid = primitive(); invalid.transform.position.x = Infinity;
    expect(() => sceneSnapshotToRenderPacket(scene([invalid]))).toThrow(/非有限/);
    expect(() => sceneSnapshotToRenderPacket({ ...scene([]), models: [primitive()] })).toThrow(/模型资源适配/);
    expect(() => sceneSnapshotToRenderPacket(scene([{ ...primitive(), material: { baseColorMapUrl: "asset.png" } }]))).toThrow(/baseColorMapUrl/);
  });
});
