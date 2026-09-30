import { packReflectionProbeRecord, type ReflectionProbeBoxSpec } from "../lighting/reflectionProbeParallax.js";
import type { StudioEnvironment } from "./studioEnvironment.js";
import { runResourceCleanup } from "./resourceCleanup.js";

export const PBR_REFLECTION_PROBE_BYTES = 128;
export interface PbrReflectionProbe {
  readonly box: ReflectionProbeBoxSpec;
  /** Prepared in the current device epoch; owned by the enclosing environment transaction. */
  readonly environment: StudioEnvironment;
}
export interface PbrReflectionProbeEnvironment extends StudioEnvironment {
  readonly reflectionProbes?: readonly PbrReflectionProbe[];
}
const EMPTY_BOX: ReflectionProbeBoxSpec = Object.freeze({ center: [0, 0, 0] as const,
  halfExtents: [1, 1, 1] as const, blendDistance: 0, influenceRadius: 0 });

/** Reuses the published C15 record layout, including its validation and f32 conversion. */
export function packPbrReflectionProbes(probes: readonly Pick<PbrReflectionProbe, "box">[] = []): Float32Array<ArrayBuffer> {
  if (!Array.isArray(probes) || probes.length > 2) throw new RangeError("At most two reflection probes are supported.");
  const result = new Float32Array(PBR_REFLECTION_PROBE_BYTES / 4);
  for (let index = 0; index < 2; index++) {
    result.set(new Float32Array(packReflectionProbeRecord(probes[index]?.box ?? EMPTY_BOX)), index * 16);
  }
  return result;
}

/** Alias fallback views are borrowed. This function never allocates textures or owns their views. */
export function pbrReflectionProbeViews(environment: PbrReflectionProbeEnvironment): readonly [GPUTextureView, GPUTextureView] {
  return [environment.reflectionProbes?.[0]?.environment.specular ?? environment.specular,
    environment.reflectionProbes?.[1]?.environment.specular ?? environment.specular];
}

/** One environment transaction owns the base and candidate probes, releasing each owner once. */
export function attachPbrReflectionProbes(base: StudioEnvironment, probes: readonly PbrReflectionProbe[]): PbrReflectionProbeEnvironment {
  packPbrReflectionProbes(probes); // Validate all records before taking ownership.
  if (probes.length === 0) return base;
  const frozen = Object.freeze(probes.map(probe => Object.freeze({ environment: probe.environment,
    box: Object.freeze({ ...probe.box, center: Object.freeze([...probe.box.center]),
      halfExtents: Object.freeze([...probe.box.halfExtents]),
      ...(probe.box.captureOffset ? { captureOffset: Object.freeze([...probe.box.captureOffset]) } : {}) }) as ReflectionProbeBoxSpec })));
  const owners = [...new Set([base, ...probes.map(probe => probe.environment)])];
  let disposed = false;
  return Object.freeze({ ...base, reflectionProbes: frozen, dispose() {
    if (disposed) return; disposed = true;
    runResourceCleanup("Reflection probe environment cleanup failed.", owners.map(owner => () => owner.dispose()));
  } });
}
