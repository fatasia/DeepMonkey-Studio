import { describe, expect, it, vi } from "vitest";
import type { GeometryResource, PreparedBatch } from "../renderPacket.js";
import type { GpuGeometryResidencyHandle } from "./gpuGeometryResidencyUploader.js";
import type { MeshBuffers } from "./meshBuffers.js";
import { stageResidentPacketGeometries } from "./residentPacketGeometryStaging.js";
import type { ResidentPacketProjection } from "./residentPacketProjection.js";

const geometry = (id: string, revision: number): GeometryResource => ({
  id, revision,
  vertices: new Float32Array([
    0, 0, 0, 0, 0, 1,
    1, 0, 0, 0, 0, 1,
    0, 1, 0, 0, 0, 1,
  ]),
  indices: new Uint32Array([0, 1, 2]),
});

const batch = (key: string, primary: string, lod?: PreparedBatch["lod"]): PreparedBatch => ({
  key, geometry: primary, instanceIds: [key], mirrored: false, doubleSided: false,
  alphaMode: "OPAQUE", data: new Float32Array(36), count: 1, ...(lod ? { lod } : {}),
});

describe("resident packet geometry staging", () => {
  it("allows a shared global handle omitted from an author-disabled level in another batch", () => {
    const sources = new Map([
      ["shared", geometry("shared", 1)],
      ["fine", geometry("fine", 2)],
      ["coarse", geometry("coarse", 3)],
    ]);
    const handles = new Map<string, GpuGeometryResidencyHandle>(["shared", "coarse"].map(id =>
      [id, { kind: "geometry", sourceId: id, sourceRevision: sources.get(id)!.revision,
        level: 0, mesh: { id } as unknown as MeshBuffers }]));
    const shared = batch("shared-batch", "shared");
    const partial = batch("partial-batch", "fine", { hysteresisRatio: 0.1, levels: [
      { geometry: "fine", minProjectedDiameterPixels: 80, geometricError: 0,
        triangles: 3, resident: true },
      { geometry: "shared", minProjectedDiameterPixels: 20, geometricError: 0.5,
        triangles: 2, resident: false },
      { geometry: "coarse", minProjectedDiameterPixels: 0, geometricError: 1,
        triangles: 1, resident: true },
    ] });
    const projection = {
      batches: [
        { source: shared, geometries: [handles.get("shared")!], textures: [] },
        { source: partial, geometries: [handles.get("coarse")!], textures: [] },
      ],
      released: false, partialLod: true,
      geometry: (id: string) => handles.get(id), geometrySource: (id: string) => sources.get(id),
      texture: () => undefined, textureSource: () => undefined, release: vi.fn(),
    } satisfies ResidentPacketProjection;

    const staged = stageResidentPacketGeometries(new Map(), projection);
    expect([...staged.geometries.keys()]).toEqual(["shared", "coarse"]);
    expect([...staged.geometryBounds.keys()]).toEqual(["shared", "fine", "coarse"]);
    expect(staged.geometries.has("fine")).toBe(false);
  });
});
