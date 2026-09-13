import {
  adaptDeepSlStandardToShaderPackage,
  type DeepPbrMeshV1MaterialDefaults,
  type DeepSlPackageAdapterResult,
} from "@bim-studio/deep-engine/shader-authoring";
import type { ShaderCompileCapabilities } from "@bim-studio/deep-engine/shader";
import {
  ShaderPackageExecutor,
  type PreparedShaderPackagePass,
} from "@bim-studio/deep-engine/webgpu";
import { drawDeepSlPbrCase, type DeepSlPbrMaterialTextureSource } from "./deepSlPbrGpuDraw.js";
import { PBR_PROBE_HEIGHT, PBR_PROBE_WIDTH } from "./deepSlPbrProbeFixture.js";
import {
  DEEP_SL_PBR_TEXTURE_SLOTS_SOURCE, evaluatePbrTextureSlotsProbe,
  pbrTextureSlotGeometry, pbrTextureSlotTangents, rgba8,
  type DeepSlPbrTextureSlotCaseId,
} from "./deepSlPbrTextureSlotsProbeFixture.js";

const PACKAGE_ID = "deep.lab.deepsl-pbr-texture-slots";
const texture = (data: Uint8Array): DeepSlPbrMaterialTextureSource => ({
  width: data.byteLength === 8 ? 2 : 1, height: 1, data,
});

function capabilities(device: GPUDevice): ShaderCompileCapabilities {
  return Object.freeze({
    features: Object.freeze([]),
    limits: Object.freeze({
      maxBindGroups: device.limits.maxBindGroups,
      maxBindingsPerBindGroup: device.limits.maxBindingsPerBindGroup,
      maxInterStageShaderVariables: device.limits.maxInterStageShaderVariables,
    }),
  });
}

export function adaptPbrTextureSlotsProbe(shaderCapabilities: ShaderCompileCapabilities): DeepSlPackageAdapterResult {
  return adaptDeepSlStandardToShaderPackage({
    schemaVersion: 1, source: DEEP_SL_PBR_TEXTURE_SLOTS_SOURCE,
    packageId: PACKAGE_ID, packageVersion: "1.0.0", compilerVersion: "1.0.0",
    capabilities: shaderCapabilities,
  });
}

function requirePasses(
  passes: readonly PreparedShaderPackagePass[],
): readonly [PreparedShaderPackagePass, PreparedShaderPackagePass] {
  const [forward, shadow] = passes;
  if (!forward || !shadow) throw new Error("PBR texture-slot executor omitted a selected forward or shadow pass.");
  return [forward, shadow];
}

function emissiveProbeMaterial(source: DeepPbrMeshV1MaterialDefaults): DeepPbrMeshV1MaterialDefaults {
  return Object.freeze({
    ...source,
    emissiveAlpha: Object.freeze([1, 1, 1, source.emissiveAlpha[3]] as const),
  });
}

interface RuntimeCase {
  readonly id: DeepSlPbrTextureSlotCaseId;
  readonly parameters: readonly number[];
  readonly metallicRoughness: Uint8Array;
  readonly normal: Uint8Array;
  readonly occlusion: Uint8Array;
  readonly emissive: Uint8Array;
}

function runtimeCases(defaults: readonly number[]): readonly RuntimeCase[] {
  const parameters = (changes: Readonly<Record<number, number>> = {}): readonly number[] => {
    const result = [...defaults];
    for (const [index, value] of Object.entries(changes)) result[Number(index)] = value;
    return Object.freeze(result);
  };
  const neutralMr = rgba8(255, 255, 0, 255);
  const neutralNormal = rgba8(128, 128, 255, 255);
  const tiltedNormal = rgba8(255, 128, 128, 255);
  const whiteAoBlackUv1 = rgba8(255, 255, 255, 255, 0, 0, 0, 255);
  const blackEmissive = rgba8(0, 0, 0, 255);
  return Object.freeze([
    { id: "neutral", parameters: parameters({ 31: 0 }), metallicRoughness: neutralMr,
      normal: tiltedNormal, occlusion: whiteAoBlackUv1, emissive: blackEmissive },
    { id: "metallic-roughness", parameters: parameters({ 31: 0 }),
      metallicRoughness: rgba8(255, 26, 255, 255), normal: tiltedNormal,
      occlusion: whiteAoBlackUv1, emissive: blackEmissive },
    { id: "normal-scale", parameters: parameters({ 31: 1 }), metallicRoughness: neutralMr,
      normal: tiltedNormal, occlusion: whiteAoBlackUv1, emissive: blackEmissive },
    { id: "occlusion-uv1", parameters: parameters({ 19: 2, 31: 0 }), metallicRoughness: neutralMr,
      normal: neutralNormal, occlusion: whiteAoBlackUv1, emissive: blackEmissive },
    { id: "emissive-srgb", parameters: parameters({ 31: 0 }), metallicRoughness: neutralMr,
      normal: neutralNormal, occlusion: whiteAoBlackUv1, emissive: rgba8(255, 0, 0, 255) },
    { id: "emissive-strength-hdr", parameters: parameters({ 31: 0, 39: 4 }), metallicRoughness: neutralMr,
      normal: neutralNormal, occlusion: whiteAoBlackUv1, emissive: rgba8(255, 0, 0, 255) },
  ]);
}

export type DeepSlPbrTextureSlotsProbeRecord = Readonly<{
  action: "deepsl-pbr-texture-slots-package-executor";
  success: boolean;
  contract?: Readonly<{
    materialBytes: 160;
    group1Bindings: 11;
    forwardVariant: "forward-normal";
    textureFormats: readonly ["srgb", "linear", "linear", "linear", "srgb"];
    runtimeControls: readonly ["uv0-uv1", "transform", "normalScale", "occlusionStrength", "emissiveStrength"];
  }>;
  gpuReadback?: Readonly<{
    colorFormat: "rgba16float";
    dimensions: readonly [typeof PBR_PROBE_WIDTH, typeof PBR_PROBE_HEIGHT];
  }>;
  cases?: readonly Readonly<{
    id: DeepSlPbrTextureSlotCaseId;
    packageCacheKey: string;
    forwardPassCacheKey: string;
    raw16: readonly number[];
    pixel: readonly number[];
  }>[];
  evaluation?: ReturnType<typeof evaluatePbrTextureSlotsProbe>;
  failure?: Readonly<{
    stage: "adapter" | "prepare" | "draw-readback" | "evaluate";
    caseId?: DeepSlPbrTextureSlotCaseId;
    message: string;
  }>;
}>;

/** Proves the five fixed material slots and tangent path on the caller's real WebGPU device. */
export async function verifyDeepSlPbrTextureSlots(device: GPUDevice): Promise<DeepSlPbrTextureSlotsProbeRecord> {
  const executor = new ShaderPackageExecutor(device);
  const samples: Array<NonNullable<DeepSlPbrTextureSlotsProbeRecord["cases"]>[number]> = [];
  let stage: NonNullable<DeepSlPbrTextureSlotsProbeRecord["failure"]>["stage"] = "adapter";
  let caseId: DeepSlPbrTextureSlotCaseId | undefined;
  try {
    const adapted = adaptPbrTextureSlotsProbe(capabilities(device));
    const material = adapted.report.materialDefaults;
    const textureDefaults = adapted.report.materialTextureDefaults;
    if (!adapted.success || !material || !textureDefaults) {
      throw new Error(adapted.report.issues.map((issue) => `${issue.code}: ${issue.message}`).join("; ")
        || "PBR texture-slot adapter omitted defaults.");
    }
    stage = "prepare";
    const prepared = await executor.prepare(adapted.package, ["webgpu/forwardCcw", "webgpu/shadowCcw"]);
    const [forward, shadow] = requirePasses(prepared.passes);
    for (const value of runtimeCases(textureDefaults.parameters)) {
      caseId = value.id;
      stage = "draw-readback";
      const drawn = await drawDeepSlPbrCase(device, forward, shadow, emissiveProbeMaterial(material), {
        geometry: pbrTextureSlotGeometry(), tangents: pbrTextureSlotTangents(),
        materialTextures: {
          parameters: value.parameters,
          baseColor: texture(rgba8(255, 255, 255, 255)),
          metallicRoughness: texture(value.metallicRoughness),
          normal: texture(value.normal), occlusion: texture(value.occlusion), emissive: texture(value.emissive),
        },
      });
      samples.push(Object.freeze({
        id: value.id, packageCacheKey: adapted.package.packageCacheKey,
        forwardPassCacheKey: forward.cacheKey, raw16: drawn.raw16, pixel: drawn.pixel,
      }));
    }
    stage = "evaluate";
    const sharedPipeline = new Set(samples.map((sample) => sample.forwardPassCacheKey)).size === 1
      && new Set(samples.map((sample) => sample.packageCacheKey)).size === 1;
    const evaluation = evaluatePbrTextureSlotsProbe(samples, sharedPipeline);
    if (!evaluation.verified) throw new Error(`PBR texture-slot GPU readback failed: ${JSON.stringify(evaluation)}`);
    return Object.freeze({
      action: "deepsl-pbr-texture-slots-package-executor", success: true,
      contract: Object.freeze({
        materialBytes: 160, group1Bindings: 11, forwardVariant: "forward-normal",
        textureFormats: Object.freeze(["srgb", "linear", "linear", "linear", "srgb"] as const),
        runtimeControls: Object.freeze(["uv0-uv1", "transform", "normalScale", "occlusionStrength", "emissiveStrength"] as const),
      }),
      gpuReadback: Object.freeze({
        colorFormat: "rgba16float", dimensions: Object.freeze([PBR_PROBE_WIDTH, PBR_PROBE_HEIGHT] as const),
      }),
      cases: Object.freeze(samples), evaluation,
    });
  } catch (error) {
    return Object.freeze({
      action: "deepsl-pbr-texture-slots-package-executor", success: false,
      failure: Object.freeze({ stage, ...(caseId ? { caseId } : {}),
        message: error instanceof Error ? error.message : String(error) }),
    });
  } finally {
    executor.dispose();
  }
}
