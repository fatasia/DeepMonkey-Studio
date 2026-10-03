import type { VirtualGeometryDagPage, VirtualGeometryDagPageTable } from "./virtualGeometryDagPages.js";

/**
 * Nanite M3 —— indirect 按页分组绘制规划。
 *
 * 每个驻留绘制页一条 drawIndexedIndirect 命令(5×u32 GPU 布局,indexCount/
 * instanceCount/firstIndex/baseVertex/firstInstance);同资产全部实例经
 * instanceCount 合并进同一命令 ⇒ draw 数 = 驻留绘制页数,与实例规模解耦
 * (与 packetLod 的 lodIndirectDraws 同型,几何页版)。baseVertex 恒 0:
 * 展开索引即层内全局顶点号,按 DAG 层绑定顶点/索引缓冲(firstIndex 为层内偏移)。
 * 本模块产出 CPU 侧计划与打包命令缓冲;GPU 上传/执行接线属 pbrRenderer 后续切片。
 */

/** drawIndexedIndirect 命令字(floats = u32 words)。 */
export const DEEP_VIRTUAL_GEOMETRY_INDIRECT_COMMAND_FLOATS = 5;
export const DEEP_VIRTUAL_GEOMETRY_INDIRECT_COMMAND_BYTES =
  DEEP_VIRTUAL_GEOMETRY_INDIRECT_COMMAND_FLOATS * 4;
/** uint32 instanceCount 寻址上限。 */
export const DEEP_VIRTUAL_GEOMETRY_MAX_INSTANCES = 0xffff_ffff;

/** 单页绘制组:命令 + 消费侧绑定信息。 */
export interface VirtualGeometryIndirectGroup {
  readonly pageId: string;
  readonly level: number;
  /** 层内全局展开索引缓冲中的起始索引。 */
  readonly firstIndex: number;
  readonly indexCount: number;
  readonly triangleCount: number;
  readonly byteLength: number;
}

export interface VirtualGeometryIndirectStats {
  /** indirect 命令数 = 驻留绘制页数(与实例数无关)。 */
  readonly drawCount: number;
  readonly instanceCount: number;
  readonly triangleCount: number;
  readonly commandBytes: number;
}

export interface VirtualGeometryIndirectPlan {
  /** 打包命令缓冲(GPU drawIndexedIndirect 布局,groups.length × 5×u32)。 */
  readonly commands: Uint32Array<ArrayBuffer>;
  /** 绘制组,按 (level 升序, cluster 升序) 确定性排列。 */
  readonly groups: readonly VirtualGeometryIndirectGroup[];
  readonly stats: VirtualGeometryIndirectStats;
}

/** 规划一次 indirect 绘制:驻留绘制页 × 实例合批。未知页 fail-loud,静默丢页会伪装降档。 */
export function planVirtualGeometryIndirect(table: VirtualGeometryDagPageTable,
  drawablePageIds: readonly string[], instanceCount: number): VirtualGeometryIndirectPlan {
  if (!Number.isSafeInteger(instanceCount) || instanceCount < 0 || instanceCount > DEEP_VIRTUAL_GEOMETRY_MAX_INSTANCES) {
    throw new RangeError(
      `Virtual geometry instanceCount must be a safe integer in [0, ${DEEP_VIRTUAL_GEOMETRY_MAX_INSTANCES}].`);
  }
  const groups: VirtualGeometryIndirectGroup[] = [];
  for (const id of drawablePageIds) {
    const page = table.byId.get(id);
    if (!page) throw new Error(`Virtual geometry indirect plan referenced unknown page: ${id}.`);
    groups.push(Object.freeze({
      pageId: page.id, level: page.level, firstIndex: page.firstIndex,
      indexCount: page.triangleCount * 3, triangleCount: page.triangleCount, byteLength: page.byteLength,
    }));
  }
  groups.sort((left, right) => left.level - right.level || pageClusterOf(table, left.pageId) - pageClusterOf(table, right.pageId));
  return Object.freeze({
    commands: encodeVirtualGeometryIndirectCommands(groups, instanceCount),
    groups: Object.freeze(groups),
    stats: Object.freeze({
      drawCount: groups.length, instanceCount,
      triangleCount: groups.reduce((sum, group) => sum + group.triangleCount, 0),
      commandBytes: groups.length * DEEP_VIRTUAL_GEOMETRY_INDIRECT_COMMAND_BYTES,
    }),
  });
}

/** 打包 drawIndexedIndirect 命令:[indexCount, instanceCount, firstIndex, baseVertex=0, firstInstance=0]。 */
export function encodeVirtualGeometryIndirectCommands(groups: readonly VirtualGeometryIndirectGroup[],
  instanceCount: number): Uint32Array<ArrayBuffer> {
  const commands = new Uint32Array(groups.length * DEEP_VIRTUAL_GEOMETRY_INDIRECT_COMMAND_FLOATS);
  for (let index = 0; index < groups.length; index += 1) {
    const group = groups[index]!;
    const base = index * DEEP_VIRTUAL_GEOMETRY_INDIRECT_COMMAND_FLOATS;
    commands[base] = group.indexCount;
    commands[base + 1] = instanceCount;
    commands[base + 2] = group.firstIndex;
    commands[base + 3] = 0;
    commands[base + 4] = 0;
  }
  return commands;
}

function pageClusterOf(table: VirtualGeometryDagPageTable, pageId: string): number {
  return (table.byId.get(pageId) as VirtualGeometryDagPage | undefined)?.cluster ?? Number.MAX_SAFE_INTEGER;
}
