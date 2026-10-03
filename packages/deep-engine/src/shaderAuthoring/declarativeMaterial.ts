import type { PbrMaterial } from "../renderPacketTypes.js";
import { sha256Utf8, hashCanonicalShaderPackage } from "../shaderPackage/hash.js";
import { adaptDeepSlToShaderPackage } from "./packageAdapterDispatch.js";
import { inspectDeepSlSurface } from "./deepSlParser.js";
import type { DeepSlSurfaceModel } from "./deepSlTypes.js";
import { normalizeExtendedMaterialParameters } from "../shader/materialParameters.js";

export interface DeclarativeMaterial {
  readonly source: string;
  readonly sourceHash: string;
  readonly defaultsHash: string;
  readonly model: DeepSlSurfaceModel;
}
const cache = new Map<string, DeclarativeMaterial>();
const owned = new WeakMap<object, DeclarativeMaterial>();
const capabilities = { features: [], limits: { maxBindGroups: 4, maxBindingsPerBindGroup: 16, maxInterStageShaderVariables: 16 } } as const;

/** Bounded declaration lowering, not arbitrary WGSL/addon execution or a security sandbox. */
export function compileDeclarativeMaterial(source: unknown): DeclarativeMaterial {
  if (typeof source !== "string" || !source.trim() || new TextEncoder().encode(source).byteLength > 32 * 1024) {
    throw new Error("声明式材质源码必须为非空且不超过32KiB的文本。");
  }
  const found = cache.get(source); if (found) return found;
  const inspection = inspectDeepSlSurface(source);
  if (!inspection.success || !inspection.model) throw new Error(inspection.diagnostics.map(d => `${d.path}: ${d.message}`).join("; "));
  const model = inspection.model;
  if (model.baseColorTexture || model.metallicRoughnessTexture || model.normalTexture || model.occlusionTexture || model.emissiveTexture
    || model.normalScale !== 1 || model.occlusionStrength !== 1) throw new Error("声明式材质当前仅消费plain标量；贴图及扩展采样必须经支持该profile的宿主。");
  if (model.surface === "unlit" && model.emissiveFactor.some(v => v !== 0)) throw new Error("当前作者Unlit材质不支持独立自发光声明。");
  const request = { schemaVersion: 1 as const, source, packageVersion: "1.0.0", compilerVersion: "1.0.0", capabilities };
  let compiled = adaptDeepSlToShaderPackage({ ...request, targetAbi: "deep.pbr.mesh.v2" });
  if (!compiled.success && compiled.report.issues.some(issue => issue.code === "unsupported-capability" && issue.path === "$.source.clearcoatFactor")) {
    compiled = adaptDeepSlToShaderPackage({ ...request, targetAbi: "deep.pbr.mesh.v3" });
  }
  if (!compiled.success) throw new Error(compiled.report.issues.map(i => `${i.path}: ${i.message}`).join("; "));
  const result = Object.freeze({ source, sourceHash: sha256Utf8(source), defaultsHash: hashCanonicalShaderPackage(model), model });
  if (cache.size >= 64) cache.delete(cache.keys().next().value!);
  cache.set(source, result); return result;
}

/** Same scalar response through the existing stock layer path; zero never adds a layer or an ABI. */
export function lowerDeclarativeMaterial(base: PbrMaterial, compiled: DeclarativeMaterial): PbrMaterial {
  const m = compiled.model;
  const { extendedParameters: _extended, layered: _layered, shadingModel: _shading, ...rest } = base;
  const material: PbrMaterial = { ...rest, baseColor: [...m.baseColor.slice(0, 3)] as [number, number, number],
    metallic: m.surface === "unlit" ? 0 : m.metallic, roughness: m.surface === "unlit" ? 1 : m.roughness,
    baseColorAlpha: m.alpha === "opaque" ? 1 : m.baseColor[3], alphaMode: m.alpha === "opaque" ? "OPAQUE" : m.alpha === "mask" ? "MASK" : "BLEND",
    alphaCutoff: m.alpha === "mask" ? 0.5 : 0, doubleSided: m.doubleSided,
    emissiveFactor: [...m.emissiveFactor] as [number, number, number], emissiveStrength: m.emissiveStrength,
    ...(m.surface === "unlit" ? { shadingModel: "unlit" } : {}) };
  if (m.clearcoatFactor === 0) return material;
  return { ...material, layered: { layers: [{ coverage: 1, mode: "replace", params: normalizeExtendedMaterialParameters({
    ior: base.ior ?? 1.5, clearcoat: { factor: m.clearcoatFactor, roughness: m.clearcoatRoughness } }),
    surface: { baseColor: material.baseColor, metallic: material.metallic, roughness: material.roughness } }] } };
}

/** Trusted main-thread application port. Cloned/userData tags alone never grant controlled Physical admission. */
export function registerDeclarativeMaterialOwner(material: object, source: string): void { owned.set(material, compileDeclarativeMaterial(source)); }
export function clearDeclarativeMaterialOwner(material: object): void { owned.delete(material); }
export function declarativeMaterialOwner(material: object): DeclarativeMaterial | undefined { return owned.get(material); }
