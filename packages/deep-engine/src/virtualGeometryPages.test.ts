import { describe, expect, it } from "vitest";
import { compileVirtualGeometryPages, type VirtualGeometryPageDependency } from "./virtualGeometryPages.js";
import type { GeometryResource, RenderInstance, RenderPacket } from "./renderPacketTypes.js";

const CELLS = 100;

function gridGeometry(id: string, revision = 0): GeometryResource {
  const stride = CELLS + 1;
  const vertexCount = stride * stride;
  const vertices = new Float32Array(vertexCount * 6);
  const uv0 = new Float32Array(vertexCount * 2);
  const tangents = new Float32Array(vertexCount * 4);
  const colors = new Float32Array(vertexCount * 4);
  for (let y = 0; y < stride; y++) for (let x = 0; x < stride; x++) {
    const vertex = y * stride + x;
    vertices.set([x, y, 0, 0, 0, 1], vertex * 6);
    uv0.set([x / CELLS, y / CELLS], vertex * 2);
    tangents.set([1, 0, 0, 1], vertex * 4);
    colors.set([x / CELLS, y / CELLS, 0, 1], vertex * 4);
  }
  const indices: number[] = [];
  for (let y = 0; y < CELLS; y++) for (let x = 0; x < CELLS; x++) {
    const a = y * stride + x, b = a + 1, c = a + stride, d = c + 1;
    indices.push(a, c, b, b, c, d);
  }
  return { id, revision, vertices, uv0, tangents, colors, indices: Uint32Array.from(indices) };
}

function cubeGeometry(id: string, revision = 0): GeometryResource {
  const vertices = new Float32Array([
    -1, -1, -1, 0, 0, -1, 1, -1, -1, 0, 0, -1, 1, 1, -1, 0, 0, -1, -1, 1, -1, 0, 0, -1,
    -1, -1, 1, 0, 0, 1, 1, -1, 1, 0, 0, 1, 1, 1, 1, 0, 0, 1, -1, 1, 1, 0, 0, 1,
  ]);
  const indices = new Uint32Array([
    0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 3, 7, 6, 3, 6, 2, 0, 4, 7, 0, 7, 3, 1, 2, 6, 1, 6, 5,
  ]);
  return { id, revision, vertices, indices };
}

function instance(id: string, geometry: string, extra: Partial<RenderInstance> = {}): RenderInstance {
  return { id, geometry, translation: [1, 2, 3], ...extra } as RenderInstance;
}

function packetOf(geometries: GeometryResource[], instances: RenderInstance[],
  extra: Partial<RenderPacket> = {}): RenderPacket {
  return { geometries, instances, ...extra } as RenderPacket;
}

function pageCoversPages(pages: readonly VirtualGeometryPageDependency[]): void {
  let expectedFirst = 0;
  for (const page of pages) {
    expect(page.firstMeshlet).toBe(expectedFirst);
    expect(page.meshletCount).toBeGreaterThan(0);
    expect(page.meshletCount).toBeLessThanOrEqual(32);
    expectedFirst = page.firstMeshlet + page.meshletCount;
  }
}

describe("compileVirtualGeometryPages", () => {
  it("keeps small packets on the zero-overhead path", () => {
    const packet = packetOf([cubeGeometry("cube")], [instance("i0", "cube")]);
    const result = compileVirtualGeometryPages(packet);
    expect(result.pages).toHaveLength(0);
    expect(result.sourceInstances.size).toBe(0);
    expect(result.packet).toBe(packet);
  });

  it("skips paging for deformation packets and posed or authored-LOD instances", () => {
    const deformed = packetOf([gridGeometry("grid")], [instance("i0", "grid")], { deformation: true });
    expect(compileVirtualGeometryPages(deformed).pages).toHaveLength(0);
    const posed = packetOf([gridGeometry("grid")], [instance("i0", "grid", { pose: [1, 0, 0, 0, 1, 0, 0, 0, 1] })]);
    expect(compileVirtualGeometryPages(posed).pages).toHaveLength(0);
    const lod = packetOf([gridGeometry("grid")], [instance("i1", "grid", { lod: 1 })]);
    expect(compileVirtualGeometryPages(lod).pages).toHaveLength(0);
  });

  it("pages a large static grid into consecutive bounded meshlet pages", () => {
    const result = compileVirtualGeometryPages(packetOf([gridGeometry("grid")], [instance("i0", "grid")]));
    expect(result.pages.length).toBeGreaterThan(1);
    pageCoversPages(result.pages);
    for (const page of result.pages) {
      expect(page.sourceGeometry).toBe("grid");
      expect(page.sourceRevision).toBe(0);
      expect(page.byteLength).toBeGreaterThan(0);
    }
    const pagedIds = new Set(result.pages.map(page => page.pageId));
    expect(result.packet.geometries.some(geometry => pagedIds.has(geometry.id))).toBe(true);
    expect(result.packet.instances).toHaveLength(result.pages.length);
  });

  it("produces stable content-addressed page ids across recompiles", () => {
    const packet = packetOf([gridGeometry("grid")], [instance("i0", "grid")]);
    const first = compileVirtualGeometryPages(packet);
    const second = compileVirtualGeometryPages(packet);
    expect(second.pages.map(page => page.pageId)).toEqual(first.pages.map(page => page.pageId));
    expect([...second.sourceInstances.values()].flat()).toEqual([...first.sourceInstances.values()].flat());
  });

  it("refreshes source revision without changing page ids when content is identical", () => {
    const first = compileVirtualGeometryPages(packetOf([gridGeometry("grid", 3)], [instance("i0", "grid")]));
    const bumped = compileVirtualGeometryPages(packetOf([gridGeometry("grid", 4)], [instance("i0", "grid")]));
    expect(bumped.pages.map(page => page.pageId)).toEqual(first.pages.map(page => page.pageId));
    expect(bumped.pages.map(page => page.sourceRevision)).toEqual(first.pages.map(() => 4));
  });

  it("changes page ids when page content changes", () => {
    const first = compileVirtualGeometryPages(packetOf([gridGeometry("grid")], [instance("i0", "grid")]));
    const moved = gridGeometry("grid");
    moved.vertices[0] = 0.5;
    const second = compileVirtualGeometryPages(packetOf([moved], [instance("i0", "grid")]));
    expect(second.pages.map(page => page.pageId)).not.toEqual(first.pages.map(page => page.pageId));
  });

  it("preserves positions and optional attributes per page against the source grid", () => {
    const source = gridGeometry("grid");
    const result = compileVirtualGeometryPages(packetOf([source], [instance("i0", "grid")]));
    const vertexStride = CELLS + 1;
    const positionOf = (geometry: GeometryResource, local: number): number[] =>
      [...geometry.vertices.subarray(local * 6, local * 6 + 3)];
    for (const page of result.pages) {
      const geometry = result.packet.geometries.find(candidate => candidate.id === page.pageId)!;
      for (let entry = 0; entry < geometry.indices.length; entry++) {
        const local = geometry.indices[entry]!;
        const world = positionOf(geometry, local);
        expect(world[2]).toBe(0);
        const matchX = Math.round(world[0]!), matchY = Math.round(world[1]!);
        const global = matchY * vertexStride + matchX;
        expect(positionOf(source, global)).toEqual(world);
      }
      // Optional streams travel with the same compaction, vertex-for-vertex.
      expect(geometry.uv0).not.toBeUndefined();
      expect(geometry.tangents).not.toBeUndefined();
      expect(geometry.colors).not.toBeUndefined();
      for (let local = 0; local < geometry.vertices.length / 6; local++) {
        // Streams are stored as f32, so compare against the f32 rounding of the same value.
        expect(geometry.uv0![local * 2]!).toBe(Math.fround(geometry.vertices[local * 6]! / CELLS));
        expect(geometry.colors![local * 4 + 3]!).toBe(1);
        expect(geometry.tangents![local * 4 + 3]!).toBe(1);
      }
    }
  });

  it("derives per-page instances and records the source instance mapping", () => {
    const result = compileVirtualGeometryPages(packetOf([gridGeometry("grid")], [instance("hero", "grid")]));
    const derived = result.sourceInstances.get("hero");
    expect(derived).toHaveLength(result.pages.length);
    expect(derived![0]).toBe("hero#deep-vg-0");
    expect(derived![1]).toBe("hero#deep-vg-1");
    const derivedInstances = result.packet.instances.filter(value => value.id.startsWith("hero#deep-vg-"));
    expect(derivedInstances).toHaveLength(result.pages.length);
    for (const value of derivedInstances) {
      expect(value.translation).toEqual([1, 2, 3]);
      expect(result.pages.some(page => page.pageId === value.geometry)).toBe(true);
    }
  });

  it("leaves instances of unpaged geometries untouched while paging others", () => {
    const result = compileVirtualGeometryPages(packetOf([cubeGeometry("cube"), gridGeometry("grid")],
      [instance("small", "cube"), instance("large", "grid")]));
    expect(result.pages.length).toBeGreaterThan(0);
    const untouched = result.packet.instances.find(value => value.id === "small");
    expect(untouched).toBeDefined();
    expect(untouched!.geometry).toBe("cube");
    expect(result.sourceInstances.has("small")).toBe(false);
    expect(result.sourceInstances.has("large")).toBe(true);
  });

  it("reports page byte length as the exact sum of geometry stream bytes", () => {
    const result = compileVirtualGeometryPages(packetOf([gridGeometry("grid")], [instance("i0", "grid")]));
    for (const page of result.pages) {
      const geometry = result.packet.geometries.find(candidate => candidate.id === page.pageId)!;
      const expected = geometry.vertices.byteLength + geometry.indices.byteLength
        + (geometry.uv0?.byteLength ?? 0) + (geometry.uv1?.byteLength ?? 0)
        + (geometry.tangents?.byteLength ?? 0) + (geometry.colors?.byteLength ?? 0);
      expect(page.byteLength).toBe(expected);
    }
  });
});
