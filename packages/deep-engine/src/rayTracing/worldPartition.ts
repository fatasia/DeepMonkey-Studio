/**
 * 世界分区数据合同 v0（波次1，开放世界基础栈）：固定世界单元网格 + 确定性流送优先级。
 * 单元内几何仍走 meshlet 分页/chunk residency；本合同只定义单元身份、状态机与排序，
 * 全部纯函数、可三方对拍（TS/Web 与 Native/Rust 的 loader 同规则实现）。
 */

export const WORLD_CELL_SIZE = 512;
export const WORLD_CELL_LOD_COUNT = 4;

export interface WorldCellId {
  /** 整数网格坐标（世界单位 = 米，除以 WORLD_CELL_SIZE）；支持负象限。 */
  readonly cx: number;
  readonly cz: number;
}

export type WorldCellState = "unloaded" | "queued" | "loading" | "resident";

export interface WorldCellStatus {
  readonly id: WorldCellId;
  readonly state: WorldCellState;
  readonly residentBytes: number;
}

export interface WorldStreamingInput {
  readonly cameraX: number;
  readonly cameraZ: number;
  /** 单位化前向方向；零向量视为无方向（全环向）。 */
  readonly forwardX: number;
  readonly forwardZ: number;
  /** 米/秒；用于前瞻预取（沿速度方向提前加载）。 */
  readonly speed: number;
}

/** 单元中心（米）。 */
export function worldCellCenter(id: WorldCellId): { readonly x: number; readonly z: number } {
  return { x: (id.cx + 0.5) * WORLD_CELL_SIZE, z: (id.cz + 0.5) * WORLD_CELL_SIZE };
}

export function worldCellOf(x: number, z: number): WorldCellId {
  if (!Number.isFinite(x) || !Number.isFinite(z)) throw new RangeError("World position must be finite.");
  return { cx: Math.floor(x / WORLD_CELL_SIZE), cz: Math.floor(z / WORLD_CELL_SIZE) };
}

export function worldCellKey(id: WorldCellId): string {
  return `${id.cx}|${id.cz}`;
}

/**
 * 确定性流送优先级：相机所在单元绝对优先（驻留剔除/拾取都先需要它），然后距离为主序，
 * 速度前瞻为加分项，前向半平面为次序加分。返回值越小越先加载；同值按 key 字典序稳定排序。
 */
export function worldStreamingPriority(id: WorldCellId, input: WorldStreamingInput): number {
  const cameraCell = worldCellOf(input.cameraX, input.cameraZ);
  if (cameraCell.cx === id.cx && cameraCell.cz === id.cz) return -Infinity;
  const center = worldCellCenter(id);
  const dx = center.x - input.cameraX, dz = center.z - input.cameraZ;
  const distance = Math.hypot(dx, dz);
  const forwardLength = Math.hypot(input.forwardX, input.forwardZ);
  const lookAhead = forwardLength > 0 && input.speed > 0
    ? (dx * input.forwardX + dz * input.forwardZ) / (forwardLength * Math.max(distance, 1))
    : 0;
  const inFront = forwardLength > 0 && (dx * input.forwardX + dz * input.forwardZ) > 0 ? 0 : 64;
  return distance + input.speed * 2 * Math.max(0, lookAhead) + inFront;
}

/** 环形请求集：相机单元 ± radius，按优先级升序、key 兜底字典序。 */
export function worldStreamingPlan(input: WorldStreamingInput, radius: number): readonly WorldCellId[] {
  if (!Number.isSafeInteger(radius) || radius < 0 || radius > 64) throw new RangeError("Streaming radius must be an integer in [0,64].");
  const center = worldCellOf(input.cameraX, input.cameraZ);
  const cells: Array<{ id: WorldCellId; priority: number; key: string }> = [];
  for (let dz = -radius; dz <= radius; dz++) {
    for (let dx = -radius; dx <= radius; dx++) {
      const id: WorldCellId = { cx: center.cx + dx, cz: center.cz + dz };
      cells.push({ id, priority: worldStreamingPriority(id, input), key: worldCellKey(id) });
    }
  }
  return cells.sort((a, b) => a.priority - b.priority || (a.key < b.key ? -1 : 1)).map(entry => entry.id);
}
