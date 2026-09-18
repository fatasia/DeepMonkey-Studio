import { describe, expect, it } from "vitest";
import { Mesh, Vector3 } from "three";
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
      metalness: -1, emissive: "#0000ff", emissiveIntensity: 12, doubleSided: true } };
    expect(sceneSnapshotToRenderPacket(scene([item])).materials[0]).toMatchObject({ baseColor: [0, 1, 0],
      roughness: 1, metallic: 0, emissiveFactor: [0, 0, 1], emissiveStrength: 10, doubleSided: true });
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
