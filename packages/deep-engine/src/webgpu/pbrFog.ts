export type PbrFogColor = readonly [number, number, number];

/** Author fog color is linear RGB. Depth is signed camera-space -Z, not radial distance. */
export type PbrFog =
  | { readonly kind: "linear"; readonly color: PbrFogColor; readonly near: number; readonly far: number }
  | { readonly kind: "exp2" | "volumetric"; readonly color: PbrFogColor; readonly density: number };

function finiteFloat(value: number, label: string): void {
  if (!Number.isFinite(value) || !Number.isFinite(Math.fround(value))) {
    throw new RangeError(`PBR fog ${label} must fit finite Float32.`);
  }
}

export function validatePbrFog(fog: PbrFog | null): void {
  if (fog === null) return;
  if (!fog || typeof fog !== "object" || Array.isArray(fog)) throw new TypeError("PBR fog must be an object or null.");
  if (!Array.isArray(fog.color) || fog.color.length !== 3) throw new TypeError("PBR fog color must contain three linear RGB values.");
  for (const value of fog.color) {
    finiteFloat(value, "color");
    if (value < 0) throw new RangeError("PBR fog color must be nonnegative.");
  }
  if (fog.kind === "exp2" || fog.kind === "volumetric") {
    finiteFloat(fog.density, "density");
    if (fog.density < 0) throw new RangeError("PBR fog density must be nonnegative.");
  } else if (fog.kind === "linear") {
    finiteFloat(fog.near, "near"); finiteFloat(fog.far, "far");
    if (fog.near < 0 || fog.far <= fog.near || Math.fround(fog.far) <= Math.fround(fog.near)) {
      throw new RangeError("PBR linear fog requires 0 <= near < far, including at Float32 precision.");
    }
  } else throw new TypeError("Unsupported PBR fog kind.");
}

/** Owns a validated snapshot so author edits cannot mutate an in-flight frame. */
export function snapshotPbrFog(fog: PbrFog | null): PbrFog | null {
  validatePbrFog(fog);
  if (fog === null) return null;
  const color: PbrFogColor = Object.freeze([fog.color[0], fog.color[1], fog.color[2]]);
  return Object.freeze(fog.kind === "linear"
    ? { kind: "linear", color, near: fog.near, far: fog.far }
    : { kind: fog.kind, color, density: fog.density });
}

/** Two vec4s: linear RGB + mode (0 off/1 linear/2 exp2/4 bounded volumetric), near/far/density/reserved. */
export function packPbrFog(fog: PbrFog | null | undefined): Float32Array<ArrayBuffer> {
  if (fog === undefined) return new Float32Array([0, 0, 0, 3, 0, 0, 0, 0]);
  validatePbrFog(fog);
  const data = new Float32Array(8);
  if (fog === null) return data;
  data.set(fog.color);
  if (fog.kind === "linear") data.set([1, fog.near, fog.far, 0], 3);
  else data.set([fog.kind === "volumetric" ? 4 : 2, 0, 0, fog.density], 3);
  return data;
}

/** Matches Three r185 fog_fragment.glsl. Linear composition assumes the author's linear HDR
 * composer path; direct display-space rendering requires a separate post-tone-map fog path. */
export function pbrFogFactor(fog: PbrFog | null, viewDepth: number): number {
  validatePbrFog(fog);
  finiteFloat(viewDepth, "view depth");
  if (fog === null) return 0;
  if (fog.kind === "exp2" || fog.kind === "volumetric") {
    if (fog.density === 0) return 0;
    const opticalDepth = fog.density * viewDepth;
    return fog.kind === "volumetric"
      ? 1 - Math.exp(-opticalDepth)
      : 1 - Math.exp(-opticalDepth * opticalDepth);
  }
  if (fog.kind !== "linear") throw new TypeError("Unsupported PBR fog kind.");
  const t = Math.max(0, Math.min(1, (viewDepth - fog.near) / (fog.far - fog.near)));
  return t * t * (3 - 2 * t);
}
