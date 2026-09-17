import { buildExperimentalXRuntimePackage, type BuildExperimentalXRuntimeInput } from "@bim-studio/deep-engine/runtime-package";

/** 显式实验作者编译入口；只冻结封闭IR，不改普通场景编译或启用player。 */
export function compileExperimentalXRuntimePackage(input: BuildExperimentalXRuntimeInput) {
  const compiled = buildExperimentalXRuntimePackage(input);
  const id = compiled.runtimePackage.entrypoints.experimentalX;
  return { ...compiled, evidence: {
    recipe: "deep-experimental-x-freeze-v1" as const,
    scope: "closed-x-ir" as const,
    resourceId: id,
    resourceHash: compiled.runtimePackage.resources.find(entry => entry.id === id)!.contentHash.value,
    packageHash: compiled.runtimePackage.packageHash.value,
    activation: "disabled-by-default" as const,
  } };
}
