import type { DeepPbrMeshShaderAbi } from "../shaderAbi/types.js";
import { hashCanonicalShaderPackage } from "./hash.js";
import type {
  ResolvedShaderPackagePipeline, ShaderPackageAbiReference, ShaderPackageDependency,
  ShaderPackageEntryPoints, ShaderPackageModule, ShaderPackagePipelineSelection,
} from "./types.js";

function byId<T extends { readonly id: string }>(values: readonly T[], id: string): T | undefined {
  return values.find((value) => value.id === id);
}

export function resolveShaderPackagePipeline(
  abi: DeepPbrMeshShaderAbi,
  selection: ShaderPackagePipelineSelection,
): ResolvedShaderPackagePipeline | undefined {
  const passVariant = byId(abi.passVariants, selection.passVariantId);
  const attachmentProfile = byId(abi.attachmentProfiles, selection.attachmentProfileId);
  const alphaMode = abi.alphaModes.find((value) => value.mode === selection.alphaMode);
  const rasterMode = byId(abi.rasterModes, selection.rasterMode);
  if (!passVariant || !attachmentProfile || !alphaMode || !rasterMode) return undefined;
  if (attachmentProfile.pass !== passVariant.pass
    || !passVariant.attachmentProfiles.includes(selection.attachmentProfileId)
    || !passVariant.alphaModes.includes(selection.alphaMode)
    || !passVariant.rasterModes.includes(selection.rasterMode)) return undefined;
  if (passVariant.pass === "forward"
    && alphaMode.forwardAttachmentProfile !== selection.attachmentProfileId) return undefined;
  if (passVariant.pass === "shadow" && selection.attachmentProfileId !== "shadow") return undefined;
  if (passVariant.pass === "depth" && selection.attachmentProfileId !== "depth") return undefined;
  if (passVariant.pass === "picking" && selection.attachmentProfileId !== "picking") return undefined;

  const bindGroupLayouts = passVariant.bindGroupLayouts
    .map((id) => byId(abi.bindGroupLayouts, id));
  const vertexStreams = passVariant.vertexStreams.map((id) => byId(abi.vertexStreams, id));
  if (bindGroupLayouts.some((value) => !value) || vertexStreams.some((value) => !value)) return undefined;
  return {
    passVariant,
    attachmentProfile,
    alphaMode,
    rasterMode,
    bindGroupLayouts: bindGroupLayouts as DeepPbrMeshShaderAbi["bindGroupLayouts"],
    vertexStreams: vertexStreams as DeepPbrMeshShaderAbi["vertexStreams"],
    dataLayouts: abi.dataLayouts,
  };
}

export interface ShaderPassCacheInput {
  readonly schemaVersion: number;
  readonly targetProfile: string;
  readonly compilerVersion: string;
  readonly techniqueId: string;
  readonly passId: string;
  readonly kind: string;
  readonly module: ShaderPackageModule;
  readonly entryPoints: ShaderPackageEntryPoints;
  readonly pipeline: ShaderPackagePipelineSelection;
  readonly shaderAbi: ShaderPackageAbiReference;
  readonly dependencies: readonly ShaderPackageDependency[];
}

/** Hashes WGSL plus every descriptor needed to create this concrete render pipeline. */
export function computeDeepShaderPassCacheKey(input: ShaderPassCacheInput): string | undefined {
  const execution = resolveShaderPackagePipeline(input.shaderAbi.contract, input.pipeline);
  if (!execution) return undefined;
  const dependencies = input.module.dependencyIds.map((id) =>
    input.dependencies.find((dependency) => dependency.id === id));
  if (dependencies.some((value) => !value)) return undefined;
  return hashCanonicalShaderPackage({
    schemaVersion: input.schemaVersion,
    targetProfile: input.targetProfile,
    compilerVersion: input.compilerVersion,
    techniqueId: input.techniqueId,
    passId: input.passId,
    kind: input.kind,
    module: {
      id: input.module.id,
      sourceHash: input.module.sourceHash,
      dependencies,
    },
    entryPoints: input.entryPoints,
    pipeline: {
      selection: input.pipeline,
      shaderAbi: { id: input.shaderAbi.id, contentHash: input.shaderAbi.contentHash },
      execution,
    },
  });
}
