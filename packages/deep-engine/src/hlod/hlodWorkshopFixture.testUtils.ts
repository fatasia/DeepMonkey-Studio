/**
 * T26 车间统计阶梯的 GLB 包围球夹具(仅测试消费;lab/ 资产只读)。
 * 直接读取 T00 已冻结的 8 份派生 GLB(lab/assets),从 JSON chunk 的
 * POSITION accessor min/max + 节点层级变换提取**真实**网格包围球——
 * 不做纹理解码、不做几何重算,保证与 `decodeTexturedGlb` 同源且零依赖浏览器。
 * glTF 与本仓库同为列主序:world = parent · child(见 factoryWorkshop.multiplyTransform 同式)。
 */

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { buildWorkshopLayout, placementTransform, type WorkshopInstanceCount } from "../../lab/factoryWorkshop.js";
import type { HlodInstanceInput } from "./hlodTypes.js";
import type { HlodInstanceShape } from "./hlodProxyTypes.js";

export interface GlbNodeBounds {
  /** GLB 包内网格节点 id(与 decodeTexturedGlb 摊平实例的命名同源,供联测映射)。 */
  readonly localId: string;
  /** 网格节点局部空间包围球(中心 = 局部 AABB 中点,半径 = 半对角线)。 */
  readonly center: readonly [number, number, number];
  readonly radius: number;
  /** 节点局部 AABB(全部图元 POSITION accessor min/max 的逐轴并);代理摘要的世界 AABB 源。 */
  readonly localMin: readonly [number, number, number];
  readonly localMax: readonly [number, number, number];
  /** 源三角形数(索引图元 = 索引数/3,非索引 = 顶点数/3;真实值,不做估算)。 */
  readonly triangleCount: number;
  /** 节点局部矩阵(列主序 16),供测试再乘 placement 变换。 */
  readonly localMatrix: readonly number[];
}

type Mat4 = readonly number[];

const GLB_JSON_CHUNK = 0x4e4f534a;

interface GlbDocument {
  readonly json: {
    readonly scenes?: readonly { readonly nodes?: readonly number[] }[];
    readonly nodes?: readonly {
      readonly name?: string;
      readonly mesh?: number;
      readonly children?: readonly number[];
      readonly matrix?: readonly number[];
      readonly translation?: readonly number[];
      readonly rotation?: readonly number[];
      readonly scale?: readonly number[];
    }[];
    readonly meshes?: readonly { readonly primitives?: readonly { readonly attributes?: { readonly POSITION?: number }; readonly indices?: number }[] }[];
    readonly accessors?: readonly { readonly min?: readonly number[]; readonly max?: readonly number[]; readonly count?: number }[];
  };
}

/** 解析 GLB 头与 JSON chunk(不解析 BIN——包围球只需 accessor min/max)。 */
export async function readGlbDocument(path: string): Promise<GlbDocument> {
  const buffer = await readFile(path);
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  if (view.getUint32(0, true) !== 0x46546c67) throw new Error(`Not a GLB: ${path}`);
  let offset = 12;
  while (offset < buffer.byteLength) {
    const length = view.getUint32(offset, true);
    const type = view.getUint32(offset + 4, true);
    if (type === GLB_JSON_CHUNK) {
      const json = new TextDecoder().decode(buffer.subarray(offset + 8, offset + 8 + length));
      return { json: JSON.parse(json) as GlbDocument["json"] };
    }
    offset += 8 + length;
  }
  throw new Error(`GLB has no JSON chunk: ${path}`);
}

function trsMatrix(node: NonNullable<GlbDocument["json"]["nodes"]>[number]): Mat4 {
  if (node.matrix) return node.matrix;
  const [tx = 0, ty = 0, tz = 0] = node.translation ?? [];
  const [qx = 0, qy = 0, qz = 0, qw = 1] = node.rotation ?? [];
  const [sx = 1, sy = 1, sz = 1] = node.scale ?? [];
  const x2 = qx + qx, y2 = qy + qy, z2 = qz + qz;
  const xx = qx * x2, xy = qx * y2, xz = qx * z2, yy = qy * y2, yz = qy * z2, zz = qz * z2;
  const wx = qw * x2, wy = qw * y2, wz = qw * z2;
  // 列主序 TRS(与 glTF 规范一致):R·S 后接平移。
  return [
    (1 - (yy + zz)) * sx, (xy + wz) * sx, (xz - wy) * sx, 0,
    (xy - wz) * sy, (1 - (xx + zz)) * sy, (yz + wx) * sy, 0,
    (xz + wy) * sz, (yz - wx) * sz, (1 - (xx + yy)) * sz, 0,
    tx, ty, tz, 1,
  ];
}

/** 列主序 4×4 乘法 out = parent · child(与 factoryWorkshop.multiplyTransform 同式)。 */
export function multiplyMat4(parent: Mat4, child: Mat4): number[] {
  const out = new Array<number>(16);
  for (let column = 0; column < 4; column++) for (let row = 0; row < 4; row++) {
    let sum = 0;
    for (let k = 0; k < 4; k++) sum += parent[k * 4 + row]! * child[column * 4 + k]!;
    out[column * 4 + row] = sum;
  }
  return out;
}

/** 列主序仿射点变换(平移 + 线性部分;placement 无缩放,半径不受影响)。 */
export function transformPoint(matrix: Mat4, point: readonly [number, number, number]): [number, number, number] {
  return [
    matrix[0]! * point[0] + matrix[4]! * point[1] + matrix[8]! * point[2] + matrix[12]!,
    matrix[1]! * point[0] + matrix[5]! * point[1] + matrix[9]! * point[2] + matrix[13]!,
    matrix[2]! * point[0] + matrix[6]! * point[1] + matrix[10]! * point[2] + matrix[14]!,
  ];
}

/** 单份车间资产的所有网格节点包围球(局部空间;确定性:场景根序与子序即 GLB 文件序)。 */
export async function workshopAssetNodeBounds(assetId: string): Promise<readonly GlbNodeBounds[]> {
  const assetsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "lab", "assets");
  const file = `${assetFile(assetId)}`;
  const document = await readGlbDocument(join(assetsDir, file));
  const { nodes = [], meshes = [], accessors = [] } = document.json;
  const results: GlbNodeBounds[] = [];
  const walk = (nodeIndex: number, parentMatrix: Mat4, path: string): void => {
    const node = nodes[nodeIndex];
    if (!node) throw new Error(`GLB node ${nodeIndex} missing in ${file}.`);
    const localMatrix = multiplyMat4(parentMatrix, trsMatrix(node));
    const nodeId = path.length === 0 ? `${node.name ?? nodeIndex}` : `${path}/${node.name ?? nodeIndex}`;
    if (node.mesh !== undefined) {
      const min: [number, number, number] = [Infinity, Infinity, Infinity];
      const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
      let triangleCount = 0;
      for (const primitive of meshes[node.mesh]?.primitives ?? []) {
        const positionAccessor = accessors[primitive.attributes?.POSITION ?? -1];
        if (!positionAccessor?.min || !positionAccessor?.max) throw new Error(`POSITION accessor min/max missing in ${file}.`);
        for (let axis = 0; axis < 3; axis++) {
          min[axis] = Math.min(min[axis]!, positionAccessor.min[axis]!);
          max[axis] = Math.max(max[axis]!, positionAccessor.max[axis]!);
        }
        const indexAccessor = primitive.indices === undefined ? undefined : accessors[primitive.indices];
        const sourceCount = (indexAccessor ? indexAccessor.count : positionAccessor.count) ?? -1;
        if (!Number.isSafeInteger(sourceCount) || sourceCount < 0 || sourceCount % 3 !== 0) {
          throw new Error(`Triangle source count invalid in ${file}: ${sourceCount}.`);
        }
        triangleCount += sourceCount / 3;
      }
      const center: [number, number, number] = [
        (min[0]! + max[0]!) * 0.5, (min[1]! + max[1]!) * 0.5, (min[2]! + max[2]!) * 0.5];
      results.push({
        localId: nodeId, center,
        radius: Math.hypot(max[0]! - min[0]!, max[1]! - min[1]!, max[2]! - min[2]!) * 0.5,
        localMin: [min[0]!, min[1]!, min[2]!], localMax: [max[0]!, max[1]!, max[2]!],
        triangleCount, localMatrix });
    }
    for (const child of node.children ?? []) walk(child, localMatrix, nodeId);
  };
  for (const root of document.json.scenes?.[0]?.nodes ?? []) walk(root, IDENTITY, "");
  if (results.length === 0) throw new Error(`GLB ${file} exposes no mesh node bounds.`);
  return results;
}

const IDENTITY: Mat4 = Object.freeze([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

/** 与 factoryWorkshop.WORKSHOP_ASSETS 同一映射(资产 id → 派生 GLB 文件名)。 */
function assetFile(assetId: string): string {
  const known: Record<string, string> = {
    machine: "FactoryMachine.glb", conveyor: "WorkshopConveyor.glb", crate: "WorkshopCrate.glb",
    hopper: "WorkshopHopper.glb", column: "WorkshopColumn.glb", catwalk: "WorkshopCatwalk.glb",
    robotArm: "WorkshopRobotArm.glb", screen: "WorkshopScreen.glb",
  };
  const file = known[assetId];
  if (!file) throw new Error(`Unknown workshop asset: ${assetId}`);
  return file;
}

/** 车间代理统计夹具:实例(树输入)+ 几何摘要(世界 AABB)+ 源三角形表(同一次遍历产出)。 */
export interface WorkshopHlodFixture {
  readonly instances: readonly HlodInstanceInput[];
  readonly shapes: readonly HlodInstanceShape[];
  readonly trianglesByInstance: ReadonlyMap<string, number>;
}

/**
 * T00 车间布局 × 派生 GLB 真实包围 → HLOD 全套输入。
 * 实例球与第一切片统计口径一致(id = `placementIndex/节点`,placement 仅平移 +
 * 绕 Y 旋转 → 半径不变);摘要 = 节点局部 AABB 的 8 角经全矩阵变换后的世界 AABB
 * (比球外切盒更紧);三角形数 = accessor 真实值。
 */
export async function workshopHlodFixture(count: WorkshopInstanceCount): Promise<WorkshopHlodFixture> {
  const layout = buildWorkshopLayout(count);
  const boundsByAsset = new Map<string, readonly GlbNodeBounds[]>();
  for (const asset of new Set(layout.placements.map(placement => placement.asset))) {
    boundsByAsset.set(asset, await workshopAssetNodeBounds(asset));
  }
  const instances: HlodInstanceInput[] = [];
  const shapes: HlodInstanceShape[] = [];
  const trianglesByInstance = new Map<string, number>();
  layout.placements.forEach((placement, placementIndex) => {
    const world = placementTransform(placement);
    for (const node of boundsByAsset.get(placement.asset)!) {
      const nodeWorld = multiplyMat4(world, node.localMatrix);
      const id = `${placementIndex}/${node.localId}`;
      instances.push({ id, position: nodeCenterWorld(nodeWorld, node), radius: node.radius });
      shapes.push(worldShapeFromCorners(id, nodeWorld, node));
      trianglesByInstance.set(id, node.triangleCount);
    }
  });
  if (instances.length !== count) throw new Error(`Workshop instances ${instances.length} != tier ${count}.`);
  return { instances, shapes, trianglesByInstance };
}

function nodeCenterWorld(world: Mat4, node: GlbNodeBounds): [number, number, number] {
  return transformPoint(world, node.center);
}

/** 局部 AABB 的 8 角经变换取逐轴 min/max:绕 Y 旋转 placement 下比球外切盒更紧的世界摘要。 */
function worldShapeFromCorners(instanceId: string, world: Mat4, node: GlbNodeBounds): HlodInstanceShape {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const [sx, sy, sz] of SHAPE_CORNER_SIGNS) {
    const corner: [number, number, number] = [
      sx ? node.localMax[0] : node.localMin[0],
      sy ? node.localMax[1] : node.localMin[1],
      sz ? node.localMax[2] : node.localMin[2],
    ];
    const world0 = transformPoint(world, corner);
    for (let axis = 0; axis < 3; axis++) {
      min[axis] = Math.min(min[axis]!, world0[axis]!);
      max[axis] = Math.max(max[axis]!, world0[axis]!);
    }
  }
  return { instanceId, min, max };
}

const SHAPE_CORNER_SIGNS: readonly (readonly [number, number, number])[] = Object.freeze([
  [0, 0, 0], [0, 0, 1], [0, 1, 0], [0, 1, 1],
  [1, 0, 0], [1, 0, 1], [1, 1, 0], [1, 1, 1],
]);

/** 实例集的世界包围球(extent = 半跨度;退化场景钳到 1e-3 防零除)。 */
export function workshopSceneSphere(instances: readonly HlodInstanceInput[]): {
  readonly center: readonly [number, number, number]; readonly extent: number;
} {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const instance of instances) {
    for (let axis = 0; axis < 3; axis++) {
      min[axis] = Math.min(min[axis]!, instance.position[axis]! - instance.radius);
      max[axis] = Math.max(max[axis]!, instance.position[axis]! + instance.radius);
    }
  }
  const center: [number, number, number] = [
    (min[0]! + max[0]!) * 0.5, (min[1]! + max[1]!) * 0.5, (min[2]! + max[2]!) * 0.5];
  const extent = Math.max(
    max[0]! - min[0]!, max[1]! - min[1]!, max[2]! - min[2]!) * 0.5;
  return { center, extent: Math.max(extent, 1e-3) };
}

/**
 * 与 createFactoryWorkshopScene 同偏移约定的相机(eye = center + extent×(1.4,1.5,1.8)×
 * distanceScale,fov π/4,540p);distanceScale 拉远/拉近观察点。
 */
export function workshopCameraAt(sphere: { readonly center: readonly [number, number, number]; readonly extent: number },
  distanceScale: number): {
    readonly position: readonly [number, number, number]; readonly forward: readonly [number, number, number];
    readonly viewportHeightPixels: number; readonly tanHalfFovY: number; readonly pixelThreshold: number;
  } {
  const tanHalfFovY = Math.tan(Math.PI / 4 / 2);
  const offset = [1.4, 1.5, 1.8].map(value => value * sphere.extent * distanceScale);
  const eye = [
    sphere.center[0] + offset[0]!, sphere.center[1] + offset[1]!, sphere.center[2] + offset[2]!] as const;
  const forward = [sphere.center[0] - eye[0], sphere.center[1] - eye[1], sphere.center[2] - eye[2]];
  const length = Math.hypot(forward[0]!, forward[1]!, forward[2]!);
  return { position: eye, forward: [forward[0]! / length, forward[1]! / length, forward[2]! / length],
    viewportHeightPixels: 540, tanHalfFovY, pixelThreshold: 1 };
}
