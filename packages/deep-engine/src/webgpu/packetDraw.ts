import type { PreparedBatch } from "../renderPacket.js";
import type { CachedPacketBatch, CachedPacketGeometry } from "./packetBufferTypes.js";
import { GPU_CULLING_MIN_INSTANCES, type PacketCullingResources } from "./packetCulling.js";
import type { PacketLodResources } from "./packetLodResources.js";
import {
  mainPipelineKey,
  materialMode,
  rasterMode,
  shadowMode,
  shadowPipelineKey,
  type Pipelines,
} from "./pipelines.js";

export type PacketDrawPhase = "shadow" | "opaque" | "transparent";

export interface PacketDrawView {
  readonly eye: readonly [number, number, number];
  readonly target: readonly [number, number, number];
}

export function drawPacketBatches(
  pass: GPURenderPassEncoder,
  pipelines: Pipelines,
  phase: PacketDrawPhase,
  batches: ReadonlyMap<string, CachedPacketBatch>,
  geometries: ReadonlyMap<string, CachedPacketGeometry>,
  culling: PacketCullingResources,
  lod?: PacketLodResources,
  _view?: PacketDrawView,
  useIndirect = false,
  shadowCascade = 0,
): { drawCalls: number; triangles: number } {
  const candidates = Array.from(batches.values()).filter(({ source }) => phase === "shadow"
    ? source.alphaMode !== "BLEND"
    : (source.alphaMode === "BLEND") === (phase === "transparent"));
  let drawCalls = 0, triangles = 0;
  for (const cached of candidates) {
    const { source, buffer, previousBuffer } = cached;
    const shadowMaterial = phase === "shadow"
      && source.alphaMode === "MASK"
      && source.textures?.baseColor !== undefined;
    pass.setPipeline(phase === "shadow" ? shadowPipeline(pipelines, source) : mainPipeline(pipelines, source));
    if ((phase !== "shadow" && source.textures) || shadowMaterial) pass.setBindGroup(1, cached.material!.group);
    if (source.lod) {
      const draws = lod?.draws(source.key);
      if (!draws) throw new Error(`LOD batch was not encoded for this frame: ${source.key}`);
      for (const draw of draws) {
        const geometry = requiredGeometry(geometries, draw.geometry);
        geometry.mesh.drawIndirect(pass, draw.instances, draw.indirect,
          phase !== "shadow" && source.textures?.normal !== undefined,
          phase === "shadow" ? undefined : draw.previousTransforms, draw.indirectOffset,
          draw.instanceByteOffset, draw.previousByteOffset);
      }
      drawCalls += draws.length;
      triangles += source.lod.levels[0]!.triangles * source.count;
      continue;
    }
    const mesh = requiredGeometry(geometries, source.geometry).mesh;
    const cullingPhase = phase === "transparent" ? "opaque" : phase;
    const culler = useIndirect && source.count >= GPU_CULLING_MIN_INSTANCES
      ? culling.phase(source.key, cullingPhase, shadowCascade)
      : undefined;
    if (culler) {
      mesh.drawIndirect(pass, culler.compacted, culler.indirect, phase !== "shadow" && source.textures?.normal !== undefined,
        phase === "shadow" ? undefined : culler.compactedPrevious);
    } else {
      mesh.draw(pass, buffer, source.count, phase !== "shadow" && source.textures?.normal !== undefined,
        phase === "shadow" ? undefined : previousBuffer);
    }
    drawCalls++;
    triangles += mesh.indexCount / 3 * source.count;
  }
  return { drawCalls, triangles };
}

function requiredGeometry(geometries: ReadonlyMap<string, CachedPacketGeometry>,
  id: string): CachedPacketGeometry {
  const geometry = geometries.get(id);
  if (!geometry) throw new Error(`Draw geometry is not resident: ${id}.`);
  return geometry;
}

function shadowPipeline(pipelines: Pipelines, batch: PreparedBatch): GPURenderPipeline {
  const mode = shadowMode(batch.alphaMode, batch.textures?.baseColor !== undefined);
  if (!mode) throw new Error("BLEND materials do not enter the shadow pass.");
  const key = shadowPipelineKey(mode, rasterMode(batch.mirrored, batch.doubleSided));
  const pipeline = pipelines.shadowPipelines.get(key);
  if (!pipeline) throw new Error(`Missing shadow pipeline: ${key}`);
  return pipeline;
}

function mainPipeline(pipelines: Pipelines, batch: PreparedBatch): GPURenderPipeline {
  const mode = materialMode(batch.textures !== undefined, batch.textures?.normal !== undefined);
  const key = mainPipelineKey(mode, batch.alphaMode === "BLEND", rasterMode(batch.mirrored, batch.doubleSided));
  const pipeline = pipelines.mainPipelines.get(key);
  if (!pipeline) throw new Error(`Missing main pipeline: ${key}`);
  return pipeline;
}
