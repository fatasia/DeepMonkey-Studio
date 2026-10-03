import type { RenderPacket } from "@bim-studio/deep-engine";
import { projectSoftBodyRenderPacket, type SoftBodyRenderBinding, type SoftBodyRuntimeSession } from "@bim-studio/deep-engine/physics";
import type { PbrRenderer, RenderView, FrameMetrics } from "@bim-studio/deep-engine/webgpu";

/** The host keeps one packet and owns the fixed clock, RAF, errors and renderer disposal. */
export interface SoftBodyPbrFrameState { packet: RenderPacket }

export function publishSoftBodyPbrTick(
  renderer: Pick<PbrRenderer, "setPacket">, session: SoftBodyRuntimeSession,
  state: SoftBodyPbrFrameState, bindings: readonly SoftBodyRenderBinding[],
): boolean {
  const next = projectSoftBodyRenderPacket(session, state.packet, bindings);
  if (next === state.packet) return false;
  renderer.setPacket(next);
  // A later render may throw after the packet has already reached the GPU owner.
  state.packet = next;
  return true;
}

/** Call after advancing the existing session by the host's fixed ticks, never RAF delta. */
export function renderSoftBodyPbrFrame(
  renderer: Pick<PbrRenderer, "setPacket" | "render">, session: SoftBodyRuntimeSession,
  state: SoftBodyPbrFrameState, bindings: readonly SoftBodyRenderBinding[], view: RenderView,
): FrameMetrics {
  publishSoftBodyPbrTick(renderer, session, state, bindings);
  const frame = renderer.render(view);
  if (!frame) throw new Error("Soft-body PBR frame was not rendered.");
  return frame;
}
