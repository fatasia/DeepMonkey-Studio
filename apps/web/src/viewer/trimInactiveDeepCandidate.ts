import type { DeepWebGpuBackend } from "@bim-studio/deep-engine/three-bridge";
import type { RenderPacket } from "@bim-studio/deep-engine";
import type { AuthoredQualityProfile } from "@bim-studio/deep-engine/webgpu";
import { advancedMaterialFeatures } from "@bim-studio/deep-engine/webgpu";
import type { PreparedStudioDeepEnvironment } from "./studioDeepEnvironmentSource";
import type { StudioDeformationPoseSync } from "./studioDeformationPoseSync";
import { STUDIO_DEEP_INACTIVE_MAX_BYTES } from "./StudioDeepInactiveCandidate";

export interface InactiveDeepCandidate {
  backend: DeepWebGpuBackend; canvas: HTMLCanvasElement; environment: PreparedStudioDeepEnvironment;
  packet: RenderPacket; shadowMapSize: number; qualityProfile: AuthoredQualityProfile | null;
  deformationSync?: StudioDeformationPoseSync | undefined;
  sceneResourcesEvicted?: boolean;
}
export function supportsInactiveMaterialProfile(backend: DeepWebGpuBackend, packet: RenderPacket): boolean {
  const mask = (backend.runtime as { advancedMaterialFeatures?: number }).advancedMaterialFeatures ?? 31;
  return !(advancedMaterialFeatures(packet.materials) & ~mask);
}

/** Called only after the renderer is hidden and its presentation work has drained. */
export function trimInactiveDeepCandidate(candidate: { backend: DeepWebGpuBackend; sceneResourcesEvicted?: boolean }, bytes: number): number {
  if (!Number.isFinite(bytes) || bytes <= STUDIO_DEEP_INACTIVE_MAX_BYTES) return bytes;
  try { if (!candidate.backend.evictSceneResources()) return bytes; }
  catch { return Number.NaN; }
  candidate.sceneResourcesEvicted = true;
  const runtime = candidate.backend.runtime as { releaseIdleResources?(): number;
    session?: { resourceMemory?: { estimatedBytes: number; unknownResources: number } } };
  runtime.releaseIdleResources?.();
  const memory = runtime.session?.resourceMemory;
  return memory?.unknownResources === 0 ? memory.estimatedBytes : Number.NaN;
}
