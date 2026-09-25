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

/** Preview is compiler evidence only. Actual pixels require a consuming renderer. */
export function inspectSceneCustomShader(source: string):
  { readonly success: true; readonly shader: DeepShaderPackageV2; readonly cacheKeys: readonly string[] }
  | { readonly success: false; readonly diagnostics: readonly string[] } {
  if (typeof source !== "string" || !source.trim() || new TextEncoder().encode(source).byteLength > MAX_SOURCE_BYTES) {
    return { success: false, diagnostics: [`DeepSL source must be 1..${MAX_SOURCE_BYTES} bytes.`] };
  }
  const packageId = `deep.scene.${runtimeContentSha256(source).slice(0, 32)}`;
  const compiled = adaptDeepSlToShaderPackage({ schemaVersion: 1, source, packageId,
    packageVersion: "1.0.0", compilerVersion: "1.0.0", targetAbi: "deep.pbr.mesh.v2",
    capabilities: CAPABILITIES });
  if (!compiled.success) return { success: false, diagnostics: compiled.report.issues.map(issue =>
    `${issue.path}: ${issue.message}`) };
  return { success: true, shader: compiled.package,
    cacheKeys: compiled.package.passes.map(pass => pass.cacheKey) };
}

function effectiveShader(material: SceneMaterialState | undefined, materialId: string): string | undefined {
  const slot = sourceMaterialSlot(materialId);
  const value = slot && material?.slotOverrides?.[slot]?.customShader !== undefined
    ? material.slotOverrides[slot]?.customShader : material?.customShader;
  return value?.source;
}

export function compileSceneCustomShaders(scene: SceneSnapshot, packet: RenderPacket): {
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
      const result = inspectSceneCustomShader(source);
      if (!result.success) throw new Error(`对象 ${object.modelId} 的 DeepSL 编译失败：${result.diagnostics.join("; ")}`);
      packageMap.set(result.shader.packageId, result.shader);
      const binding = { materialId, packageId: result.shader.packageId, techniqueId: "webgpu" };
      const previous = bindingMap.get(materialId);
      if (previous && previous.packageId !== binding.packageId) throw new Error(`材质 ${materialId} 存在冲突的 DeepSL 绑定`);
      bindingMap.set(materialId, binding);
    }
  }
  return {
    shaderPackages: [...packageMap.values()].sort((a, b) => a.packageId.localeCompare(b.packageId))
      .map(value => ({ revision: 1, value })),
    materialBindings: [...bindingMap.values()].sort((a, b) => a.materialId < b.materialId ? -1 : a.materialId > b.materialId ? 1 : 0),
  };
}
