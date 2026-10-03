import type { RuntimeAuthoredLighting } from "../runtimePackage/environmentTypes.js";
import { validateRuntimeEnvironment } from "../runtimePackage/environment.js";
import { ggxSpecularTimesCosine } from "../lighting/ltc.js";
import { evaluatePathTraceOpaquePbr } from "./pathTraceOpaquePbr.js";
import { ptCross, ptDot, ptNormalize, type PathTraceCpuMaterial, type PathTraceRgb,
  type PathTraceVec3 } from "./pathTraceCpuTypes.js";

/** Snapshot the existing compiled lighting contract. Exposure belongs to display, not HDR radiance. */
export function preparePathTraceDirectionalLight(value: RuntimeAuthoredLighting | undefined) {
  if (value === undefined) return undefined;
  const lighting = structuredClone(value);
  if ((lighting.localLights !== undefined && !Array.isArray(lighting.localLights))
    || (lighting.lightProfiles !== undefined && !Array.isArray(lighting.lightProfiles))) {
    throw new Error("Invalid CPU path trace local lights/IES lighting.");
  }
  if (lighting.localLights?.length || lighting.lightProfiles?.length) {
    throw new Error("CPU path trace unsupported local lights/IES lighting.");
  }
  delete (lighting as { localLights?: unknown }).localLights;
  delete (lighting as { lightProfiles?: unknown }).lightProfiles;
  validateRuntimeEnvironment({ schema: "deep-engine.solid-environment", schemaVersion: 8,
    id: "scene.environment", revision: 1, kind: "solid-background-builtin-ibl", backgroundSrgb: [0, 0, 0],
    outputTransform: "native-aces-studio-v8", lighting }, "scene.environment", 1, "$.pathTrace.environment");
  return Object.freeze({ direction: Object.freeze([...lighting.direction]) as PathTraceRgb,
    radiance: Object.freeze([...lighting.radiance]) as PathTraceRgb, shadows: lighting.shadows });
}

/** Delta NEE uses BSDF*cosine once; it never divides by the continuous mixture PDF. */
export function evaluatePathTraceDirect(material: PathTraceCpuMaterial, normal: PathTraceRgb,
  view: PathTraceRgb, direction: PathTraceRgb): PathTraceVec3 {
  const cosine = Math.max(0, ptDot(normal, direction));
  if (cosine === 0) return [0, 0, 0];
  if (material.model === "production-opaque-pbr") return evaluatePathTraceOpaquePbr(material, normal, view, direction).cosineRgb;
  if (material.model === "lambert") return material.reflectance.map(value => value * cosine / Math.PI) as PathTraceVec3;
  const tangent = ptNormalize(ptCross(Math.abs(normal[2]) < .999 ? [0, 0, 1] : [0, 1, 0], normal));
  const bitangent = ptCross(normal, tangent);
  const local = (v: PathTraceRgb): PathTraceVec3 => [ptDot(v, tangent), ptDot(v, bitangent), ptDot(v, normal)];
  const base = ggxSpecularTimesCosine(local(direction), local(view), material.roughness! ** 2);
  const vh = Math.min(1, ptDot(view, ptNormalize([view[0] + direction[0], view[1] + direction[1], view[2] + direction[2]])));
  return material.reflectance.map(f0 => (f0 + (1 - f0) * (1 - vh) ** 5) * base) as PathTraceVec3;
}
