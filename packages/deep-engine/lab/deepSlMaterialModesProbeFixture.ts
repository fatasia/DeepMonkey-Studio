import { PBR_PROBE_CLEAR, pbrProbeGeometry } from "./deepSlPbrProbeFixture.js";

export type DeepSlMaterialModeCaseId =
  | "mask-below-cutoff"
  | "mask-above-cutoff"
  | "backface-single-sided"
  | "backface-double-sided";

export interface DeepSlMaterialModeGpuSample {
  readonly id: DeepSlMaterialModeCaseId;
  readonly pixel: readonly number[];
  readonly shadowDepth: number;
}

export function materialModeSource(alpha: number, mode: "opaque" | "mask", doubleSided: boolean): string {
  return `shader deep.material-modes {
  surface standard;
  baseColor [0.75, 0.08, 0.06, ${alpha}];
  metallic 0;
  roughness 0.8;
  alpha ${mode};
  doubleSided ${doubleSided};
  baseColorTexture off;
}`;
}

export function reversedPbrProbeGeometry(): Float32Array {
  const source = pbrProbeGeometry();
  const reversed = new Float32Array(source.length);
  reversed.set(source.subarray(0, 10), 0);
  reversed.set(source.subarray(20, 30), 10);
  reversed.set(source.subarray(10, 20), 20);
  return reversed;
}

function maxColorDelta(pixel: readonly number[]): number {
  return Math.max(...pixel.map((value, index) => Math.abs(value - PBR_PROBE_CLEAR[index]!)));
}

export function evaluateMaterialModesProbe(samples: readonly DeepSlMaterialModeGpuSample[]) {
  const byId = new Map(samples.map((sample) => [sample.id, sample]));
  const below = byId.get("mask-below-cutoff");
  const above = byId.get("mask-above-cutoff");
  const single = byId.get("backface-single-sided");
  const double = byId.get("backface-double-sided");
  const complete = samples.length === 4 && byId.size === 4 && below !== undefined && above !== undefined
    && single !== undefined && double !== undefined;
  const finite = complete && samples.every((sample) => sample.pixel.length === 4
    && sample.pixel.every(Number.isFinite) && Number.isFinite(sample.shadowDepth));
  const maskColorCutoff = finite && maxColorDelta(below.pixel) < 0.002 && maxColorDelta(above.pixel) > 0.03;
  const maskShadowCutoff = finite && below.shadowDepth > 0.99
    && above.shadowDepth > 0.45 && above.shadowDepth < 0.55;
  const singleSidedCulled = finite && maxColorDelta(single.pixel) < 0.002 && single.shadowDepth > 0.99;
  const doubleSidedVisible = finite && maxColorDelta(double.pixel) > 0.03
    && double.shadowDepth > 0.45 && double.shadowDepth < 0.55;
  return Object.freeze({
    finite, maskColorCutoff, maskShadowCutoff, singleSidedCulled, doubleSidedVisible,
    colorDeltas: Object.freeze({
      below: below ? maxColorDelta(below.pixel) : Number.NaN,
      above: above ? maxColorDelta(above.pixel) : Number.NaN,
      single: single ? maxColorDelta(single.pixel) : Number.NaN,
      double: double ? maxColorDelta(double.pixel) : Number.NaN,
    }),
    shadowDepths: Object.freeze({
      below: below?.shadowDepth ?? Number.NaN,
      above: above?.shadowDepth ?? Number.NaN,
      single: single?.shadowDepth ?? Number.NaN,
      double: double?.shadowDepth ?? Number.NaN,
    }),
    verified: finite && maskColorCutoff && maskShadowCutoff && singleSidedCulled && doubleSidedVisible,
  });
}
