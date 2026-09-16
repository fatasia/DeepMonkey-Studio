import type { PreparedBatch } from "../renderPacket.js";
import type { PacketDrawPhase } from "./packetDraw.js";
import type { PacketCullingDraw } from "./packetCulling.js";
import type { Pipelines } from "./pipelines.js";

export interface PacketDeformationBatchDraw {
  readonly pose: string;
  readonly pipelines: Pipelines;
  /** Phase-compatible group 1 combining current/previous pose storage and material resources. */
  readonly group: GPUBindGroup;
  readonly stale: boolean;
}

export interface PacketDeformationDynamicCulling extends PacketCullingDraw {
  /** Explicit evidence that this result used current deformed bounds, not static geometry bounds. */
  readonly bounds: "deformed";
}

export interface PacketDeformationDrawContext {
  resolve(batch: PreparedBatch, phase: PacketDrawPhase, authorShadow: boolean): PacketDeformationBatchDraw | undefined;
  dynamicCulling?(batch: PreparedBatch, phase: "shadow" | "opaque", cascade: number): PacketDeformationDynamicCulling | undefined;
}

export function resolveDeformationDraw(batch: PreparedBatch, phase: PacketDrawPhase, authorShadow: boolean,
  context?: PacketDeformationDrawContext): PacketDeformationBatchDraw | undefined {
  if (batch.pose === undefined) return undefined;
  if (phase === "display") throw new Error("Deformation direct display is not supported.");
  if (batch.lod) throw new Error("Deformation LOD draw is not supported.");
  const draw = context?.resolve(batch, phase, authorShadow);
  if (!draw || draw.pose !== batch.pose || !draw.group || !draw.pipelines?.deformationPlainLayout) {
    throw new Error(`Missing deformation draw resources: ${batch.key}.`);
  }
  if (draw.stale !== false) throw new Error(`Stale deformation draw resources: ${batch.key}.`);
  return draw;
}
