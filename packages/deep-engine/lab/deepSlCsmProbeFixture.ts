import { adaptDeepSlStandardToShaderPackage } from "@bim-studio/deep-engine/shader-authoring";
import type { ShaderCompileCapabilities } from "@bim-studio/deep-engine/shader";
import { DEEP_SL_PBR_PROBE_SOURCES, PBR_PROBE_CLEAR, pbrProbeFrame } from "./deepSlPbrProbeFixture.js";
import type { DeepSlPbrGpuSample } from "./deepSlPbrGpuDrawSupport.js";

export const CSM_PROBE_POINTS = Object.freeze([[4, 8], [12, 8]] as const);
export const CSM_PROBE_STATES = Object.freeze([
  { id: "all-lit", depths: [1, 1, 1, 1] as const },
  { id: "cascade-0-blocked", depths: [0.2, 1, 1, 1] as const },
  { id: "cascade-1-blocked", depths: [1, 0.2, 1, 1] as const },
]);
export type CsmProbeCase = Readonly<{ id: string; sample: DeepSlPbrGpuSample }>;

export function adaptDeepSlCsmProbe(capabilities: ShaderCompileCapabilities) {
  return adaptDeepSlStandardToShaderPackage({
    schemaVersion: 1, source: DEEP_SL_PBR_PROBE_SOURCES["rough-red"],
    packageId: "deep.lab.deepsl-csm-probe", packageVersion: "1.0.0", compilerVersion: "1.0.0",
    targetAbi: "deep.pbr.mesh.v2", capabilities,
  });
}

export function csmProbeUniform(): Float32Array {
  const data = new Float32Array(84);
  const identity = pbrProbeFrame().subarray(0, 16);
  for (let layer = 0; layer < 4; layer += 1) data.set(identity, layer * 16);
  data.set([0, 2, 4, 6], 64);
  data.set([-0.125, 1.5, 3.5, 5.5], 68);
  data.set([0, 0, 0, 0], 72);
  data.set([4, 0.001, 1 / 16, 0], 76);
  // 横向观察方向使左/右样点分别选择 cascade 0/1，远离混合带。
  data.set([1, 0, 0, 0], 80);
  return data;
}

const luminance = (pixel: readonly number[]) => pixel[0]! * 0.2126 + pixel[1]! * 0.7152 + pixel[2]! * 0.0722;

export function evaluateCsmProbe(cases: readonly CsmProbeCase[]) {
  const ordered = CSM_PROBE_STATES.map(state => cases.find(entry => entry.id === state.id)?.sample);
  const valid = cases.length === 3 && new Set(cases.map(entry => entry.id)).size === 3
    && ordered.every(sample => sample?.samplePixels?.length === 2
      && sample.samplePixels.every(pixel => pixel.length === 4 && pixel.every(Number.isFinite)
        && Math.abs(pixel[3]! - 1) < 0.01));
  const baseline = ordered[0]?.samplePixels;
  const deltas = [1, 2].map(index => [0, 1].map(point => valid
    ? luminance(ordered[index]!.samplePixels![point]!) - luminance(baseline![point]!) : Number.NaN));
  const nonClear = valid && baseline!.every(pixel => Math.max(
    ...pixel.map((value, index) => Math.abs(value - PBR_PROBE_CLEAR[index]!)),
  ) > 0.05);
  const isolatedCascade0 = valid && deltas[0]![0]! < -0.03 && Math.abs(deltas[0]![1]!) <= 0.005;
  const isolatedCascade1 = valid && deltas[1]![1]! < -0.03 && Math.abs(deltas[1]![0]!) <= 0.005;
  const shadowExecuted = ordered.every(sample => Number.isFinite(sample?.shadowDepth)
    && Math.abs(sample!.shadowDepth - 0.5) < 0.02 && sample!.shadowDraws === 1);
  return Object.freeze({ valid, nonClear, isolatedCascade0, isolatedCascade1, shadowExecuted,
    luminanceDeltas: Object.freeze(deltas.map(delta => Object.freeze(delta))),
    verified: valid && nonClear && isolatedCascade0 && isolatedCascade1 && shadowExecuted });
}
