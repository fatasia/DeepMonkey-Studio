/**
 * T26 HLOD 胞元几何:根胞元推导、八分桶、收缩与最小包围球。
 *
 * - 根胞元:side = 2^ceil(log2(4×maxExtent)),center 吸附 side/2 网格到场景中点
 *   (吸附偏移 ≤ side/4,余量保证必然包含全体);同一成员集逐位同根胞元。
 * - 八分:子胞元边界 = 父中心 ± side/4(side 是 2 的幂,f64 精确,无边界抖动);
 *   成员按中心点落入唯一八分——边界几何与成员集合无关(增量局部性的根基)。
 * - 最小包围球:精确 AABB(center ± radius)取中点,半径 = max(‖c−child.c‖+r)
 *   ——保守包含全部子球,逐位确定。
 */

import { HlodError, type HlodClusterNode, type HlodCell, type HlodInstanceInput } from "./hlodTypes.js";

export interface Cell {
  readonly center: readonly [number, number, number];
  readonly side: number;
}

type Instance = HlodInstanceInput;

/** 根胞元最小边长:全共点(extent 0)时退化到常数,避免 log2(0)。 */
export const MIN_ROOT_CELL_SIDE = 1e-6;

export function rootCellOf(members: readonly Instance[]): HlodCell {
  if (members.length === 0) return Object.freeze({ center: [0, 0, 0] as const, side: MIN_ROOT_CELL_SIDE });
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const instance of members) {
    for (let axis = 0; axis < 3; axis++) {
      min[axis] = Math.min(min[axis]!, instance.position[axis]!);
      max[axis] = Math.max(max[axis]!, instance.position[axis]!);
    }
  }
  const extent = Math.max(max[0]! - min[0]!, max[1]! - min[1]!, max[2]! - min[2]!);
  const side = extent > 0 ? 2 ** Math.ceil(Math.log2(4 * extent)) : MIN_ROOT_CELL_SIDE;
  if (!Number.isFinite(side) || side <= 0) {
    throw new HlodError("invalid-instance", "HLOD instance extent overflows the root cell representation.");
  }
  const snap = (value: number): number => Math.round(value / (side / 2)) * (side / 2);
  return Object.freeze({ center: Object.freeze([snap((min[0]! + max[0]!) * 0.5),
    snap((min[1]! + max[1]!) * 0.5), snap((min[2]! + max[2]!) * 0.5)] as const), side });
}

export function bucketByOctant(members: readonly Instance[], cell: Cell): {
  readonly lists: readonly Instance[][]; readonly occupied: number; readonly singleOctant: number | undefined;
} {
  const lists: Instance[][] = Array.from({ length: 8 }, () => []);
  for (const instance of members) {
    const octant = (instance.position[0] >= cell.center[0] ? 1 : 0)
      | (instance.position[1] >= cell.center[1] ? 2 : 0)
      | (instance.position[2] >= cell.center[2] ? 4 : 0);
    lists[octant]!.push(instance);
  }
  let occupied = 0;
  let singleOctant: number | undefined = undefined;
  for (let octant = 0; octant < 8; octant++) {
    if (lists[octant]!.length === 0) continue;
    occupied += 1;
    singleOctant = octant;
  }
  return { lists, occupied, singleOctant };
}

export function shrunkCell(cell: Cell, octant: number): Cell {
  const half = cell.side / 4;
  return {
    center: [
      cell.center[0] + (octant & 1 ? half : -half),
      cell.center[1] + (octant & 2 ? half : -half),
      cell.center[2] + (octant & 4 ? half : -half),
    ],
    side: cell.side / 2,
  };
}

/** 子球的最小包围球:先精确 AABB,中心取中点,半径 = max(‖center−child.center‖ + child.radius)。 */
export function enclosingSphere(children: readonly HlodClusterNode[]): { center: [number, number, number]; radius: number } {
  if (children.length === 0) return { center: [0, 0, 0], radius: 0 };
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const child of children) {
    for (let axis = 0; axis < 3; axis++) {
      min[axis] = Math.min(min[axis]!, child.center[axis]! - child.radius);
      max[axis] = Math.max(max[axis]!, child.center[axis]! + child.radius);
    }
  }
  const center: [number, number, number] = [(min[0]! + max[0]!) * 0.5, (min[1]! + max[1]!) * 0.5, (min[2]! + max[2]!) * 0.5];
  let radius = 0;
  for (const child of children) {
    radius = Math.max(radius, Math.hypot(child.center[0] - center[0], child.center[1] - center[1],
      child.center[2] - center[2]) + child.radius);
  }
  return { center, radius };
}
