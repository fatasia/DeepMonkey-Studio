import type { PreparedBatch } from "../renderPacket.js";
import type { CachedPacketBatch, CachedPacketGeometry } from "./packetBufferTypes.js";
import { GPU_CULLING_MIN_INSTANCES, type PacketCullingResources } from "./packetCulling.js";
import type { PacketLodResources } from "./packetLodResources.js";
import { resolveDeformationDraw, type PacketDeformationDrawContext } from "./packetDeformationDraw.js";
import {
  mainPipelineKey,
  materialMode,
  rasterMode,
  shadowMode,
  shadowPipelineKey,
  type Pipelines,
} from "./pipelines.js";

export type PacketDrawPhase = "shadow" | "opaque" | "transparent" | "display";

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
  directionalOnly = false,
  authorShadow = false,
  deformation?: PacketDeformationDrawContext,
): { drawCalls: number; triangles: number } {
  const candidates = Array.from(batches.values()).filter(({ source }) => phase === "shadow"
    ? (source.alphaMode !== "BLEND" || authorShadow) && source.castShadow !== false
    : (source.alphaMode === "BLEND") === (phase === "transparent"));
  const draws = candidates.map(cached => {
    const dynamic = resolveDeformationDraw(cached.source, phase, authorShadow, deformation);
    const materialNeeded = (phase !== "shadow" && cached.source.textures !== undefined)
      || (cached.source.alphaMode === "MASK" && cached.source.textures?.baseColor !== undefined);
    const selected = dynamic?.pipelines ?? (materialNeeded && !cached.arrayMaterial
      ? pipelines.textureArrayFallback ?? pipelines : pipelines);
    const pipeline = phase === "shadow" ? shadowPipeline(selected, cached.source, authorShadow)
      : mainPipeline(selected, cached.source, phase === "display", directionalOnly);
    const cullingPhase = phase === "shadow" ? "shadow" : "opaque";
    const dynamicCuller = dynamic && useIndirect && cached.source.count >= GPU_CULLING_MIN_INSTANCES
      ? deformation?.dynamicCulling?.(cached.source, cullingPhase, shadowCascade) : undefined;
    if (dynamicCuller && !culling.isDynamicPhase(dynamicCuller, cached.source, cullingPhase, shadowCascade))
      throw new Error("Deformation indirect draw requires current owner-verified dynamic bounds.");
    return { cached, dynamic, pipeline, dynamicCuller };
  });
  let drawCalls = 0, triangles = 0;
  let activePipeline: GPURenderPipeline | undefined;
  let activeMaterialGroup: GPUBindGroup | undefined;
  for (const { cached, dynamic, pipeline, dynamicCuller } of draws) {
    const { source, buffer, previousBuffer } = cached;
    const shadowMaterial = phase === "shadow"
      && source.alphaMode === "MASK"
      && source.textures?.baseColor !== undefined;
    if (pipeline !== activePipeline) {
      pass.setPipeline(pipeline); activePipeline = pipeline;
      // Different pipeline layouts may disturb group 1; only dedupe within a stable pipeline run.
      activeMaterialGroup = undefined;
    }
    const arrayMaterial = !dynamic && ((phase !== "shadow" && source.textures) || shadowMaterial)
      ? cached.arrayMaterial : undefined;
    const materialGroup = dynamic ? dynamic.group : arrayMaterial?.group
      ?? ((phase !== "shadow" && source.textures) || shadowMaterial ? cached.material!.group : undefined);
    if (materialGroup && materialGroup !== activeMaterialGroup) {
      pass.setBindGroup(1, materialGroup); activeMaterialGroup = materialGroup;
    }
    if (source.lod) {
      const draws = lod?.draws(source.key);
      if (!draws) throw new Error(`LOD batch was not encoded for this frame: ${source.key}`);
      for (const draw of draws) {
        const geometry = requiredGeometry(geometries, draw.geometry);
        if (draw.meshlets) {
          geometry.mesh.drawMeshletIndirect(pass, draw, phase !== "shadow" && source.textures?.normal !== undefined, phase !== "shadow");
          continue;
        }
        geometry.mesh.drawIndirect(pass, draw.instances, draw.indirect,
          phase !== "shadow" && source.textures?.normal !== undefined,
          phase === "shadow" ? undefined : draw.previousTransforms, draw.indirectOffset,
          draw.instanceByteOffset, draw.previousByteOffset);
      }
      drawCalls += draws.reduce((count, draw) => count + (draw.meshlets?.commandCount ?? 1), 0);
      triangles += (source.lod.strategy === "author-selected"
        ? source.lod.selectedLevels.reduce((sum, level) => sum + source.lod!.levels[level]!.triangles, 0)
        : source.lod.levels[0]!.triangles) * source.count;
      continue;
    }
    const mesh = requiredGeometry(geometries, source.geometry).mesh;
    const cullingPhase = phase === "shadow" ? "shadow" : "opaque";
    const culler = dynamic ? dynamicCuller : useIndirect && source.count >= GPU_CULLING_MIN_INSTANCES
      ? culling.phase(source.key, cullingPhase, shadowCascade)
      : undefined;
    if (culler) {
      mesh.drawIndirect(pass, culler.compacted, culler.indirect, !dynamic && phase !== "shadow" && source.textures?.normal !== undefined,
        phase === "shadow" || phase === "display" ? undefined : culler.compactedPrevious);
    } else {
      mesh.draw(pass, buffer, source.count, !dynamic && phase !== "shadow" && source.textures?.normal !== undefined,
        phase === "shadow" || phase === "display" ? undefined : previousBuffer);
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

function shadowPipeline(pipelines: Pipelines, batch: PreparedBatch, authorShadow: boolean): GPURenderPipeline {
  // Three 的透明材质在 alphaTest=0 时仍写完整阴影深度；opacity 不是裁切阈值。
  // BLEND batches do not carry the material cutoff in this draw contract;
  // keep their historical solid-depth caster route. Explicit MASK batches
  // still use the material shadow pipeline.
  const alphaMode = authorShadow && batch.alphaMode === "BLEND"
    ? "MASK"
    : batch.alphaMode;
  const mode = shadowMode(alphaMode, batch.textures?.baseColor !== undefined);
  if (!mode) throw new Error("BLEND materials do not enter the shadow pass.");
  const key = shadowPipelineKey(mode, rasterMode(batch.mirrored, batch.doubleSided));
  const pipeline = pipelines.shadowPipelines.get(key)
    // Older test/integration pipeline bundles may not include the optional
    // material mask variant; preserve their solid-depth fallback.
    ?? (batch.alphaMode === "BLEND"
      ? pipelines.shadowPipelines.get(shadowPipelineKey("solid", rasterMode(batch.mirrored, batch.doubleSided)))
      : undefined)
    // 分级重上(2026-10-06):mask/authored 变体 release 后才创建,就绪前经 solid 回退
    // 按实心投影(与页物化同 documented 简化,见 pipelines.ts 页物化注释);就绪后
    // 按 key 命中恢复逐像素掩码。author/ 前缀变体同样回退非 authored solid。
    ?? pipelines.shadowPipelines.get(shadowPipelineKey("solid", rasterMode(batch.mirrored, batch.doubleSided)));
  if (!pipeline) throw new Error(`Missing shadow pipeline: ${key}`);
  return pipeline;
}

function mainPipeline(pipelines: Pipelines, batch: PreparedBatch, directDisplay: boolean,
  directionalOnly: boolean): GPURenderPipeline {
  const mode = materialMode(batch.textures !== undefined, batch.textures?.normal !== undefined);
  // AA-M2:a2c 变体只在多采样 mainPipelines 中存在(display 直出渲染进 1x swapchain,
  // WebGPU validation 禁止 alphaToCoverageEnabled × sampleCount=1,物理不支持)。
  // directDisplay 档 a2c 批次回退普通管线 —— 管线侧退化为 alphaTest 语义(a2c 位
  // 的 alpha 直通在 1x 无消费),能力边界在能力声明与交付报告中披露。
  const alphaToCoverage = !directDisplay && batch.alphaToCoverage === true;
  const key = mainPipelineKey(mode, batch.alphaMode === "BLEND", rasterMode(batch.mirrored, batch.doubleSided), alphaToCoverage);
  const optimized = directDisplay && directionalOnly && mode === "plain"
    ? pipelines.displayDirectionalPipelines.get(key) : undefined;
  const source = directDisplay ? pipelines.displayPipelines : pipelines.mainPipelines;
  const pipeline = optimized ?? source.get(key);
  if (!pipeline) {
    if (alphaToCoverage && !directDisplay) {
      throw new Error(`Missing main pipeline: ${key} (alphaToCoverage requires the MSAA main-pass pipeline set).`);
    }
    throw new Error(`Missing ${directDisplay ? "display" : "main"} pipeline: ${key}`);
  }
  return pipeline;
}
