import { computeMeshletBounds, triangleNormal, type MeshletBounds } from "./meshletBounds.js";
import { budget, validateMeshletInput } from "./inputValidation.js";
import { packLocalTriangle, unpackLocalTriangle } from "./localTriangle.js";
import {
  MESHLET_BOUNDS_STRIDE,
  MESHLET_BUILD_BUDGETS,
  MESHLET_DESCRIPTOR_STRIDE,
  MESHLET_SCHEMA_VERSION,
  MeshletError,
  type IndexedTriangleGeometry,
  type MeshletBuildOptions,
  type MeshletBuildResult,
} from "./types.js";

type Vec3 = readonly [number, number, number];

interface PendingMeshlet {
  readonly localByGlobal: Map<number, number>;
  readonly vertices: number[];
  readonly triangles: number[];
  readonly normals: Vec3[];
  hasDegenerate: boolean;
}

export function buildMeshlets(
  geometry: IndexedTriangleGeometry,
  options: MeshletBuildOptions = {},
): MeshletBuildResult {
  const input = validateMeshletInput(geometry, options);
  const descriptors: number[] = [], remap: number[] = [], triangles: number[] = [], bounds: number[] = [];
  let pending = createPending();

  const flush = (): void => {
    if (pending.triangles.length === 0) return;
    budget(descriptors.length / MESHLET_DESCRIPTOR_STRIDE + 1, MESHLET_BUILD_BUDGETS.outputMeshlets, "output meshlets");
    descriptors.push(remap.length, pending.vertices.length, triangles.length, pending.triangles.length);
    remap.push(...pending.vertices);
    triangles.push(...pending.triangles);
    appendBounds(bounds, computeMeshletBounds(input.positions, pending.vertices, pending.normals, pending.hasDegenerate));
    assertOutputBudget(descriptors.length, remap.length, triangles.length, bounds.length);
    pending = createPending();
  };

  for (let offset = 0; offset < input.indices.length; offset += 3) {
    const global = [input.indices[offset]!, input.indices[offset + 1]!, input.indices[offset + 2]!] as const;
    let addedVertices = pending.localByGlobal.has(global[0]) ? 0 : 1;
    if (global[1] !== global[0] && !pending.localByGlobal.has(global[1])) addedVertices += 1;
    if (global[2] !== global[0] && global[2] !== global[1] && !pending.localByGlobal.has(global[2])) addedVertices += 1;
    if (pending.triangles.length >= input.maxTriangles || pending.vertices.length + addedVertices > input.maxVertices) flush();
    const local = global.map((vertex) => localVertex(pending, vertex)) as [number, number, number];
    pending.triangles.push(packLocalTriangle(local[0], local[1], local[2]));
    const normal = triangleNormal(input.positions, global[0], global[1], global[2]);
    if (normal) pending.normals.push(normal);
    else pending.hasDegenerate = true;
  }
  flush();

  try {
    return Object.freeze({
      schemaVersion: MESHLET_SCHEMA_VERSION,
      sourceVertexCount: input.vertexCount,
      sourceTriangleCount: input.triangleCount,
      meshletCount: descriptors.length / MESHLET_DESCRIPTOR_STRIDE,
      maxVertices: input.maxVertices,
      maxTriangles: input.maxTriangles,
      descriptors: Uint32Array.from(descriptors),
      vertexRemap: Uint32Array.from(remap),
      localTriangleIndices: Uint32Array.from(triangles),
      bounds: Float32Array.from(bounds),
    } satisfies MeshletBuildResult);
  } catch (cause) {
    throw new MeshletError("overflow", "Meshlet output allocation failed.", { cause });
  }
}

function createPending(): PendingMeshlet {
  return { localByGlobal: new Map(), vertices: [], triangles: [], normals: [], hasDegenerate: false };
}

export { packLocalTriangle, unpackLocalTriangle };

function localVertex(meshlet: PendingMeshlet, global: number): number {
  const existing = meshlet.localByGlobal.get(global);
  if (existing !== undefined) return existing;
  const local = meshlet.vertices.length;
  meshlet.localByGlobal.set(global, local);
  meshlet.vertices.push(global);
  return local;
}

function appendBounds(target: number[], value: MeshletBounds): void {
  target.push(...value.sphere, ...value.aabbMin, 0, ...value.aabbMax, 0, ...value.cone);
}

function assertOutputBudget(descriptors: number, remap: number, triangles: number, bounds: number): void {
  const bytes = (descriptors + remap + triangles + bounds) * Uint32Array.BYTES_PER_ELEMENT;
  if (!Number.isSafeInteger(bytes) || bytes > MESHLET_BUILD_BUDGETS.outputBytes) {
    throw new MeshletError("budget-exceeded", `Meshlet output exceeds ${MESHLET_BUILD_BUDGETS.outputBytes} bytes.`);
  }
  if (bounds % MESHLET_BOUNDS_STRIDE !== 0) throw new MeshletError("overflow", "Meshlet bounds layout is misaligned.");
}
