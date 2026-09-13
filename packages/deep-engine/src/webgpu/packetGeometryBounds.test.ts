import { describe, expect, it } from "vitest";
import { prepareRenderPacket, type GeometryResource } from "../renderPacket.js";
import { createPacketGeometryBounds } from "./packetGeometryBounds.js";

function geometry(overrides: Partial<GeometryResource> = {}): GeometryResource {
  return {
    id: "mesh",
    revision: 4,
    vertices: new Float32Array([
      -2, -1, 0, 0, 0, 1,
      2, -1, 0, 0, 0, 1,
      0, 3, 0, 0, 0, 1,
      100, 100, 100, 0, 0, 1,
    ]),
    indices: new Uint32Array([0, 1, 2]),
    ...overrides,
  };
}

function packet(source = geometry()) {
  return prepareRenderPacket({
    geometries: [source],
    materials: [{ id: "mat", baseColor: [1, 1, 1], metallic: 0, roughness: 1 }],
    instances: [{ id: "instance", geometry: source.id, material: "mat",
      transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] }],
  });
}

describe("createPacketGeometryBounds", () => {
  it("computes conservative indexed bounds and compact metadata from a prepared packet", () => {
    const result = createPacketGeometryBounds(packet());
    const value = result.get("mesh")!;

    expect(value).toEqual({
      kind: "geometry",
      id: "mesh",
      revision: 4,
      center: [0, 1, 0],
      radius: Math.sqrt(8),
      triangleCount: 1,
    });
    expect(value.radius).toBeGreaterThanOrEqual(Math.hypot(-2, -2, 0));
    expect(value).not.toHaveProperty("mesh");
    expect(value).not.toHaveProperty("vertices");
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(value)).toBe(true);
    expect(Object.isFrozen(value.center)).toBe(true);
    expect("set" in result).toBe(false);
  });

  it("accepts a readonly map, keeps iteration stable, and does not retain array content", () => {
    const source = geometry({ id: "direct", revision: 9 });
    const result = createPacketGeometryBounds(new Map([[source.id, source]]));
    const before = result.get("direct")!;
    source.vertices.fill(42);
    source.indices.fill(3);

    expect([...result]).toEqual([["direct", before]]);
    expect(before.center).toEqual([0, 1, 0]);
    expect(before.radius).toBe(Math.sqrt(8));
    expect(before.triangleCount).toBe(1);
  });

  it("inflates degenerate indexed geometry to a finite conservative radius", () => {
    const point = geometry({
      vertices: new Float32Array([
        5, -2, 7, 0, 0, 1,
        5, -2, 7, 0, 0, 1,
        5, -2, 7, 0, 0, 1,
      ]),
    });
    const value = createPacketGeometryBounds(new Map([[point.id, point]])).get(point.id)!;
    expect(value.center).toEqual([5, -2, 7]);
    expect(value.radius).toBe(1e-6);
    expect(Number.isFinite(value.radius)).toBe(true);
  });

  it("rejects malformed sources and strict identity or kind mismatches", () => {
    expect(() => createPacketGeometryBounds(null as never)).toThrow("source is invalid");
    expect(() => createPacketGeometryBounds(new Map([["alias", geometry()]])))
      .toThrow("Invalid packet geometry identity");
    expect(() => createPacketGeometryBounds(new Map([[" ", geometry({ id: " " })]])))
      .toThrow("Invalid packet geometry identity");
    const wrongKind = { ...geometry(), kind: "texture" } as unknown as GeometryResource;
    expect(() => createPacketGeometryBounds(new Map([[wrongKind.id, wrongKind]])))
      .toThrow("Invalid packet geometry identity");
  });

  it("rejects out-of-range indices and every non-finite vertex channel", () => {
    expect(() => createPacketGeometryBounds(new Map([["mesh", geometry({
      indices: new Uint32Array([0, 1, 8]),
    })]]))).toThrow("out-of-range indices");
    const invalidPosition = geometry();
    invalidPosition.vertices[0] = Number.NaN;
    expect(() => createPacketGeometryBounds(new Map([[invalidPosition.id, invalidPosition]])))
      .toThrow("non-finite vertices");
    const invalidNormal = geometry();
    invalidNormal.vertices[3] = Number.POSITIVE_INFINITY;
    expect(() => createPacketGeometryBounds(new Map([[invalidNormal.id, invalidNormal]])))
      .toThrow("non-finite vertices");
  });

  it("returns an empty immutable index for an empty geometry map", () => {
    const result = createPacketGeometryBounds(new Map());
    expect(result.size).toBe(0);
    expect([...result]).toEqual([]);
    expect(Object.isFrozen(result)).toBe(true);
  });
});
