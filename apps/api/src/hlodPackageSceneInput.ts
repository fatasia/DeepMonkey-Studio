import { NodeIO, type Accessor, type Mesh, type Node } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import draco3d from "draco3dgltf";
import { MeshoptDecoder } from "meshoptimizer";
import type { RenderPacket } from "@bim-studio/deep-engine";
import { HlodError } from "@bim-studio/deep-engine/hlod";
import type { HlodPackageInstanceInput } from "./hlodPackageTypes.js";

/**
 * T26 接线的场景输入适配层:GLB 场景文件 / 既有 RenderPacket → 核心构建入参
 * (`HlodPackageInstanceInput`:世界包围球 + 世界 AABB + 真实三角形数)。
 *
 * 适配器约定(两个适配器同一形态,与核心解耦):
 * - 几何局部 AABB(GLB = POSITION accessor min/max 并;渲染包 = 索引顶点实测)的
 *   8 角经世界矩阵/实例变换(列主序 4×4)变换取逐轴并 = 世界 AABB;
 *   包围球 = 该世界盒中心 + 半对角线(同源同形、随缩放自洽、确定性)。
 * - 三角形数 = 索引图元索引数/3,非索引图元顶点数/3(真实值,不估算)。
 * - fail-closed:实例 id 冲突、变换非法、缺 POSITION min/max 直接抛错,不静默缩场景。
 */

export interface GlbHlodExtractionResult {
  readonly instances: readonly HlodPackageInstanceInput[];
  /** 非 TRIANGLES 图元跳过数(GLB 适配口径,与 T12/T17 一致)。 */
  readonly skippedNonTrianglePrimitives: number;
  /** 无 POSITION min/max 或零三角形的网格节点数(不冒充实例)。 */
  readonly skippedMeshNodes: number;
}

/** GLB 场景 → HLOD 实例输入(生产入口;只读输入文件)。 */
export async function extractHlodInstancesFromGlb(filePath: string): Promise<GlbHlodExtractionResult> {
  const io = await glbIo();
  const document = await io.read(filePath);
  const scene = document.getRoot().listScenes()[0];
  if (!scene) throw new HlodError("invalid-instance", `GLB exposes no scene: ${filePath}`);
  const instances: HlodPackageInstanceInput[] = [];
  const seen = new Set<string>();
  let skippedNonTrianglePrimitives = 0;
  let skippedMeshNodes = 0;
  const walk = (node: Node, path: string): void => {
    const mesh = node.getMesh();
    if (mesh) {
      const instanceId = `node:${path}${node.getName() ? `:${node.getName()}` : ""}`;
      if (seen.has(instanceId)) {
        throw new HlodError("duplicate-instance-id", `Duplicate GLB instance id: ${instanceId}`);
      }
      seen.add(instanceId);
      const extracted = meshNodeInstance(instanceId, mesh, node.getWorldMatrix());
      if (extracted) instances.push(extracted);
      else skippedMeshNodes += 1;
    }
    node.listChildren().forEach((child, childIndex) => walk(child, path ? `${path}.${childIndex}` : String(childIndex)));
  };
  scene.listChildren().forEach((root, rootIndex) => walk(root, String(rootIndex)));
  if (instances.length === 0) {
    throw new HlodError("invalid-instance", `GLB exposes no usable mesh node: ${filePath}`);
  }
  return Object.freeze({ instances: Object.freeze(instances), skippedNonTrianglePrimitives, skippedMeshNodes });
}

/** RenderPacket → HLOD 实例输入(renderPacket 接线路径:几何局部 AABB × 实例变换)。 */
export function extractHlodInstancesFromRenderPacket(packet: RenderPacket): readonly HlodPackageInstanceInput[] {
  if (!packet || !Array.isArray(packet.instances) || !Array.isArray(packet.geometries)) {
    throw new HlodError("invalid-instance", "RenderPacket must carry instances and geometries arrays.");
  }
  const boxByGeometry = new Map<string, readonly number[]>();
  const trianglesByGeometry = new Map<string, number>();
  const seen = new Set<string>();
  const instances = packet.instances.map(instance => {
    if (seen.has(instance.id)) {
      throw new HlodError("duplicate-instance-id", `Duplicate RenderPacket instance id: ${instance.id}`);
    }
    seen.add(instance.id);
    if (!Array.isArray(instance.transform) || instance.transform.length !== 16
      || !instance.transform.every((value: number) => Number.isFinite(value))) {
      throw new HlodError("invalid-instance", `RenderPacket instance ${instance.id} has an invalid transform.`);
    }
    let box = boxByGeometry.get(instance.geometry);
    if (!box) {
      const geometry = packet.geometries.find(candidate => candidate.id === instance.geometry);
      if (!geometry) {
        throw new HlodError("unknown-instance",
          `RenderPacket instance ${instance.id} references missing geometry ${instance.geometry}.`);
      }
      box = indexedGeometryBox(geometry.vertices, geometry.indices);
      trianglesByGeometry.set(instance.geometry, geometry.indices.length / 3);
      boxByGeometry.set(instance.geometry, box);
    }
    return instanceFromBox(instance.id, box, trianglesByGeometry.get(instance.geometry)!, instance.transform);
  });
  return Object.freeze(instances);
}

// ---------------------------------------------------------------------------
// 内部:局部盒 × 世界矩阵 → 实例(球 = 盒中心 + 半对角线)。
// ---------------------------------------------------------------------------

function meshNodeInstance(instanceId: string, mesh: Mesh, worldMatrix: ArrayLike<number>):
  HlodPackageInstanceInput | null {
  let min: [number, number, number] = [Infinity, Infinity, Infinity];
  let max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  let hasBounds = false;
  let triangles = 0;
  for (const primitive of mesh.listPrimitives()) {
    if (primitive.getMode() !== 4) continue;
    const position = primitive.getAttribute("POSITION") as Accessor | null;
    if (!position) return null;
    const accessorMin = position.getMin([]), accessorMax = position.getMax([]);
    if (!accessorMin || !accessorMax) return null;
    for (let axis = 0; axis < 3; axis++) {
      min[axis] = Math.min(min[axis]!, accessorMin[axis]!);
      max[axis] = Math.max(max[axis]!, accessorMax[axis]!);
    }
    hasBounds = true;
    const indexAccessor = primitive.getIndices();
    const sourceCount = indexAccessor ? indexAccessor.getCount() : position.getCount();
    if (!Number.isSafeInteger(sourceCount) || sourceCount < 0 || sourceCount % 3 !== 0) {
      throw new HlodError("invalid-instance", `Triangle source count invalid for ${instanceId}: ${sourceCount}.`);
    }
    triangles += sourceCount / 3;
  }
  if (!hasBounds || triangles === 0) return null;
  return instanceFromBox(instanceId, [min[0]!, min[1]!, min[2]!, max[0]!, max[1]!, max[2]!],
    triangles, worldMatrix);
}

function indexedGeometryBox(vertices: ArrayLike<number>, indices: ArrayLike<number>): readonly number[] {
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let index = 0; index < indices.length; index += 1) {
    const offset = indices[index]! * 6;
    const x = vertices[offset]!, y = vertices[offset + 1]!, z = vertices[offset + 2]!;
    minX = Math.min(minX, x); minY = Math.min(minY, y); minZ = Math.min(minZ, z);
    maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); maxZ = Math.max(maxZ, z);
  }
  if (![minX, minY, minZ, maxX, maxY, maxZ].every(Number.isFinite)) {
    throw new HlodError("invalid-instance", "RenderPacket geometry has no indexed vertices.");
  }
  return [minX, minY, minZ, maxX, maxY, maxZ];
}

/** 局部 AABB[minX,minY,minZ,maxX,maxY,maxZ] 的 8 角经列主序 4×4 变换取逐轴并。 */
function instanceFromBox(instanceId: string, localBox: readonly number[], triangles: number,
  matrix: ArrayLike<number>): HlodPackageInstanceInput {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let corner = 0; corner < 8; corner += 1) {
    const point = transformPoint(matrix, [
      corner & 1 ? localBox[3]! : localBox[0]!,
      corner & 2 ? localBox[4]! : localBox[1]!,
      corner & 4 ? localBox[5]! : localBox[2]!,
    ]);
    for (let axis = 0; axis < 3; axis++) {
      min[axis] = Math.min(min[axis]!, point[axis]!);
      max[axis] = Math.max(max[axis]!, point[axis]!);
    }
  }
  const center: [number, number, number] = [
    (min[0]! + max[0]!) * 0.5, (min[1]! + max[1]!) * 0.5, (min[2]! + max[2]!) * 0.5];
  const radius = Math.hypot(max[0]! - min[0]!, max[1]! - min[1]!, max[2]! - min[2]!) * 0.5;
  return Object.freeze({
    instanceId, sphereCenter: Object.freeze(center), sphereRadius: radius,
    min: Object.freeze(min), max: Object.freeze(max), triangles,
  });
}

function transformPoint(matrix: ArrayLike<number>, point: readonly [number, number, number]): [number, number, number] {
  return [
    matrix[0]! * point[0]! + matrix[4]! * point[1]! + matrix[8]! * point[2]! + matrix[12]!,
    matrix[1]! * point[0]! + matrix[5]! * point[1]! + matrix[9]! * point[2]! + matrix[13]!,
    matrix[2]! * point[0]! + matrix[6]! * point[1]! + matrix[10]! * point[2]! + matrix[14]!,
  ];
}

let glbIoPromise: Promise<NodeIO> | undefined;

async function glbIo(): Promise<NodeIO> {
  glbIoPromise ??= draco3d.createDecoderModule().then((decoder) => new NodeIO()
    .registerExtensions(ALL_EXTENSIONS)
    .registerDependencies({ "draco3d.decoder": decoder, "meshopt.decoder": MeshoptDecoder }));
  return glbIoPromise;
}
