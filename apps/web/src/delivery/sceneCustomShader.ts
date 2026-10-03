import { compareText } from "@bim-studio/contracts";
import type { SceneMaterialState, SceneSnapshot } from "@bim-studio/contracts";
import type { RenderPacket } from "@bim-studio/deep-engine";
import { adaptDeepSlToShaderPackage } from "@bim-studio/deep-engine/shader-authoring";
import type { DeepShaderPackageV2 } from "@bim-studio/deep-engine/shader-package";
import { runtimeContentSha256, type RuntimeMaterialShaderBinding } from "@bim-studio/deep-engine/runtime-package";
import { sourceMaterialSlot } from "./sceneMaterialOverrides";

const CAPABILITIES = {
  features: [],
  limits: { maxBindGroups: 4, maxBindingsPerBindGroup: 16, maxInterStageShaderVariables: 16 },
} as const;
const MAX_SOURCE_BYTES = 32 * 1024;
type SceneShaderAbi = "deep.pbr.mesh.v2" | "deep.pbr.mesh.v3";
export interface SceneCustomShaderProfile {
  /** Compiler/host capability, not a persisted author field or proof of executed pixels. */
  readonly shaderAbis?: readonly SceneShaderAbi[];
}
const PREVIEW_ABIS: readonly SceneShaderAbi[] = ["deep.pbr.mesh.v2", "deep.pbr.mesh.v3"];
const PRODUCTION_ABIS: readonly SceneShaderAbi[] = ["deep.pbr.mesh.v2"];

/** Preview is compiler evidence only. Actual pixels require a consuming renderer. */
export function inspectSceneCustomShader(source: string, profile: SceneCustomShaderProfile = {}):
  { readonly success: true; readonly shader: DeepShaderPackageV2; readonly cacheKeys: readonly string[] }
  | { readonly success: false; readonly diagnostics: readonly string[] } {
  if (typeof source !== "string" || !source.trim() || new TextEncoder().encode(source).byteLength > MAX_SOURCE_BYTES) {
    return { success: false, diagnostics: [`DeepSL source must be 1..${MAX_SOURCE_BYTES} bytes.`] };
  }
  const packageId = `deep.scene.${runtimeContentSha256(source).slice(0, 32)}`;
  const request = { schemaVersion: 1 as const, source, packageId,
    packageVersion: "1.0.0", compilerVersion: "1.0.0", capabilities: CAPABILITIES };
  let compiled = adaptDeepSlToShaderPackage({ ...request, targetAbi: "deep.pbr.mesh.v2" });
  // Only the existing typed adapter may require an upgrade; invalid source is never retried as a fallback.
  if (!compiled.success && compiled.report.issues.some(issue => issue.code === "unsupported-capability"
    && issue.path === "$.source.clearcoatFactor")) {
    compiled = adaptDeepSlToShaderPackage({ ...request, targetAbi: "deep.pbr.mesh.v3" });
  }
  if (!compiled.success) return { success: false, diagnostics: compiled.report.issues.map(issue =>
    `${issue.path}: ${issue.message}`) };
  const supported = profile.shaderAbis ?? PREVIEW_ABIS;
  if (!Array.isArray(supported) || !supported.every(abi => PREVIEW_ABIS.includes(abi))) {
    return { success: false, diagnostics: ["$.shaderAbis: unsupported shader profile; declare only mesh ABI v2/v3."] };
  }
  if (!supported.includes(compiled.package.shaderAbi.id as SceneShaderAbi)) return { success: false,
    diagnostics: [`$.shaderAbi: 当前宿主尚未连接 ${compiled.package.shaderAbi.id} 的实例流与绘制消费；源码未降级，请在支持该 profile 的宿主重试。`] };
  return { success: true, shader: compiled.package,
    cacheKeys: compiled.package.passes.map(pass => pass.cacheKey) };
}

function effectiveShader(material: SceneMaterialState | undefined, materialId: string): string | undefined {
  const slot = sourceMaterialSlot(materialId);
  const value = slot && material?.slotOverrides?.[slot]?.customShader !== undefined
    ? material.slotOverrides[slot]?.customShader : material?.customShader;
  return value?.source;
}

export function compileSceneCustomShaders(scene: SceneSnapshot, packet: RenderPacket, profile: SceneCustomShaderProfile = {}): {
  readonly shaderPackages: readonly { readonly revision: number; readonly value: DeepShaderPackageV2 }[];
  readonly materialBindings: readonly RuntimeMaterialShaderBinding[];
} {
  const materials = new Map(packet.materials.map(material => [material.id, material]));
  const instances = new Map(packet.instances.map(instance => [instance.id, instance]));
  const packageMap = new Map<string, DeepShaderPackageV2>();
  const bindingMap = new Map<string, RuntimeMaterialShaderBinding>();
  for (const object of [...scene.primitives, ...scene.models]) {
    if (!object.visible) continue;
    const bound = packet.objectBindings?.find(item => item.nodeId === object.modelId);
    for (const instanceId of bound?.instanceIds ?? []) {
      const materialId = instances.get(instanceId)?.material;
      if (!materialId || !materials.has(materialId)) throw new Error(`Shader object ${object.modelId} lost material ${instanceId}.`);
      const source = effectiveShader(object.material, materialId);
      if (source === undefined) continue;
      const result = inspectSceneCustomShader(source, { shaderAbis: profile.shaderAbis ?? PRODUCTION_ABIS });
      if (!result.success) throw new Error(`对象 ${object.modelId} 的 DeepSL 编译失败：${result.diagnostics.join("; ")}`);
      packageMap.set(result.shader.packageId, result.shader);
      const binding = { materialId, packageId: result.shader.packageId, techniqueId: "webgpu" };
      const previous = bindingMap.get(materialId);
      if (previous && previous.packageId !== binding.packageId) throw new Error(`材质 ${materialId} 存在冲突的 DeepSL 绑定`);
      bindingMap.set(materialId, binding);
    }
  }
  return {
    shaderPackages: [...packageMap.values()].sort((a, b) => compareText(a.packageId, b.packageId))
      .map(value => ({ revision: 1, value })),
    materialBindings: [...bindingMap.values()].sort((a, b) => a.materialId < b.materialId ? -1 : a.materialId > b.materialId ? 1 : 0),
  };
}
