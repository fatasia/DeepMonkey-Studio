import type { PreparedBatch } from "../renderPacket.js";
import type { CachedPacketBatch, CachedPacketGeometry } from "./packetBufferTypes.js";
import type { PacketLodResources } from "./packetLodResources.js";

/** 实例记录(36 float)中表面 flags 的 float 下标;bit 256 = 对象级 outline,见 renderPacketBatches。 */
const FLAGS_FLOAT = 31, RECORD_FLOATS = 36, OUTLINE_BIT = 256;
// 批次源在数据变化时整体替换(updatePacketInstances 以 data 不等为准),按源对象缓存计数安全。
const counts = new WeakMap<PreparedBatch, number>();

export function outlinedInstanceCount(source: PreparedBatch): number {
  let count = counts.get(source);
  if (count !== undefined) return count;
  count = 0;
  const data = source.data;
  for (let offset = FLAGS_FLOAT; offset < data.length; offset += RECORD_FLOATS) {
    if ((Math.round(data[offset]!) & OUTLINE_BIT) !== 0) count++;
  }
  counts.set(source, count);
  return count;
}

/** 无描边实例时恒为 false:每帧代价仅为批次数次 WeakMap 命中,无分配。 */
export function hasOutlinedInstances(batches: ReadonlyMap<string, CachedPacketBatch>): boolean {
  for (const { source } of batches.values()) if (outlinedInstanceCount(source) > 0) return true;
  return false;
}

/**
 * 以阴影管线同款顶点布局(slot0 位置/slot1 实例)绘制含描边实例的批次;未描边实例由顶点着色器剔除。
 * 变形(pose)与 meshlet 簇批次暂不进入掩码,计入 skippedBatches 供上层如实上报。
 */
export function drawOutlineMask(pass: GPURenderPassEncoder, batches: ReadonlyMap<string, CachedPacketBatch>,
  geometries: ReadonlyMap<string, CachedPacketGeometry>, lod?: PacketLodResources): { drawCalls: number; skippedBatches: number } {
  let drawCalls = 0, skippedBatches = 0;
  for (const { source, buffer } of batches.values()) {
    if (outlinedInstanceCount(source) === 0) continue;
    if (source.pose !== undefined) { skippedBatches++; continue; }
    if (source.lod) {
      const draws = lod?.draws(source.key);
      if (!draws) throw new Error(`LOD batch was not encoded for this frame: ${source.key}`);
      for (const draw of draws) {
        if (draw.meshlets) { skippedBatches++; continue; }
        requiredGeometry(geometries, draw.geometry).mesh.drawIndirect(pass, draw.instances, draw.indirect, false,
          undefined, draw.indirectOffset, draw.instanceByteOffset);
        drawCalls++;
      }
      continue;
    }
    requiredGeometry(geometries, source.geometry).mesh.draw(pass, buffer, source.count, false);
    drawCalls++;
  }
  return { drawCalls, skippedBatches };
}

function requiredGeometry(geometries: ReadonlyMap<string, CachedPacketGeometry>, id: string): CachedPacketGeometry {
  const geometry = geometries.get(id);
  if (!geometry) throw new Error(`Outline geometry is not resident: ${id}.`);
  return geometry;
}
