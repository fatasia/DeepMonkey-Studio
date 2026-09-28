import type { RenderPacket } from "../renderPacket.js";
import { buildReferenceRoomScene, REFERENCE_FLOOR_ALBEDO, REFERENCE_WALL_ALBEDO,
  type ReferenceBox, type ReferenceScene } from "./probeReferenceScene.js";

/**
 * T02 GPU 联测桥：把参考场景（房间+薄墙+门洞+天窗）物化为 RenderPacket，使其能进入
 * 既有 GPU 生产链（buildRenderPacketRayScene → packTlasScene → probeRadianceKernel）。
 * 每个 ReferenceBox 一个 geometry（36 顶点 × 6 float 位置+法线，面法线轴对齐、外向 CCW），
 * 两个 material（地板/墙，反照率取场景常量），12 个 identity 实例。反照率与参考功能量
 * 完全一致，因此 GPU 探针值（经 π 补偿后）与 CPU 参考积分器同口径可比。
 */

export const REFERENCE_FLOOR_MATERIAL_ID = "reference-floor";
export const REFERENCE_WALL_MATERIAL_ID = "reference-wall";
export const REFERENCE_INSTANCE_TRANSFORM = Object.freeze([
  1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]) as readonly number[];

/** 单个盒子的 6 面 × 2 三角形顶点（36 顶点，位置+面法线交错）。 */
export function referenceBoxVertices(box: ReferenceBox): Float32Array<ArrayBuffer> {
  const vertices = new Float32Array(36 * 6) as Float32Array<ArrayBuffer>;
  let cursor = 0;
  const corner = (axis: number, sign: number, first: number, second: number,
    u: number, v: number): readonly number[] => {
    const position = [0, 0, 0];
    position[axis] = sign > 0 ? box.max[axis]! : box.min[axis]!;
    position[u] = first > 0 ? box.max[u]! : box.min[u]!;
    position[v] = second > 0 ? box.max[v]! : box.min[v]!;
    return position;
  };
  for (let axis = 0; axis < 3; axis++) {
    for (const sign of [1, -1]) {
      let u = (axis + 1) % 3, v = (axis + 2) % 3;
      if (sign < 0) { const swap = u; u = v; v = swap; }
      const normal = [0, 0, 0];
      normal[axis] = sign;
      // 四角按 (0,0)(1,0)(1,1)(0,1) 环绕；u/v 交换保证负向面也是外向 CCW。
      const quad = [corner(axis, sign, 0, 0, u, v), corner(axis, sign, 1, 0, u, v),
        corner(axis, sign, 1, 1, u, v), corner(axis, sign, 0, 1, u, v)];
      for (const index of [0, 1, 2, 0, 2, 3]) {
        const position = quad[index]!;
        vertices.set([position[0]!, position[1]!, position[2]!,
          normal[0]!, normal[1]!, normal[2]!], cursor);
        cursor += 6;
      }
    }
  }
  return vertices;
}

/**
 * 参考场景 → RenderPacket：12 个 box geometry + 地板/墙 2 个 material + 12 个 identity
 * 实例（box 0 为地板材质，其余为墙材质）。确定性、无随机性。
 */
export function buildReferenceRenderPacket(scene: ReferenceScene = buildReferenceRoomScene()): RenderPacket {
  if (scene.boxes.length === 0) throw new RangeError("Reference scene must contain at least one box.");
  const geometries = scene.boxes.map((box, index) => ({
    id: `reference-box-${index}`, revision: 0, vertices: referenceBoxVertices(box),
    indices: new Uint32Array(Array.from({ length: 36 }, (_, corner) => corner)),
  }));
  const materialFor = (index: number): string =>
    index === 0 ? REFERENCE_FLOOR_MATERIAL_ID : REFERENCE_WALL_MATERIAL_ID;
  const floorColor: readonly [number, number, number] = [REFERENCE_FLOOR_ALBEDO[0]!,
    REFERENCE_FLOOR_ALBEDO[1]!, REFERENCE_FLOOR_ALBEDO[2]!];
  const wallColor: readonly [number, number, number] = [REFERENCE_WALL_ALBEDO[0]!,
    REFERENCE_WALL_ALBEDO[1]!, REFERENCE_WALL_ALBEDO[2]!];
  return {
    geometries,
    materials: [
      { id: REFERENCE_FLOOR_MATERIAL_ID, baseColor: floorColor, metallic: 0, roughness: 1 },
      { id: REFERENCE_WALL_MATERIAL_ID, baseColor: wallColor, metallic: 0, roughness: 1 },
    ],
    instances: scene.boxes.map((_, index) => ({
      id: `reference-solid-${index}`, geometry: `reference-box-${index}`,
      material: materialFor(index), transform: [...REFERENCE_INSTANCE_TRANSFORM] })),
  };
}
