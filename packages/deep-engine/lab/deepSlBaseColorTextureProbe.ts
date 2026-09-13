import {
  adaptDeepSlStandardToShaderPackage,
  type DeepSlPackageAdapterResult,
} from "@bim-studio/deep-engine/shader-authoring";
import type { ShaderCompileCapabilities } from "@bim-studio/deep-engine/shader";
import {
  ShaderPackageExecutor,
  type PreparedShaderPackagePass,
} from "@bim-studio/deep-engine/webgpu";
import {
  baseColorProbeTexture, baseColorTextureSource, constantUv0ProbeGeometry,
  evaluateBaseColorTextureProbe, translatedBaseColorParameters,
  type DeepSlBaseColorTextureCaseId,
} from "./deepSlBaseColorTextureProbeFixture.js";
import { drawDeepSlPbrCase } from "./deepSlPbrGpuDraw.js";
import { PBR_PROBE_HEIGHT, PBR_PROBE_WIDTH } from "./deepSlPbrProbeFixture.js";

const PACKAGE_ID = "deep.lab.deepsl-base-color-texture";

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

export function adaptBaseColorTextureProbe(
  alpha: "opaque" | "mask",
  shaderCapabilities: ShaderCompileCapabilities,
): DeepSlPackageAdapterResult {
  return adaptDeepSlStandardToShaderPackage({
    schemaVersion: 1,
    source: baseColorTextureSource(alpha),
    packageId: `${PACKAGE_ID}.${alpha}`,
    packageVersion: "1.0.0",
    compilerVersion: "1.0.0",
    capabilities: shaderCapabilities,
  });
}

function requirePasses(
  passes: readonly PreparedShaderPackagePass[],
): readonly [PreparedShaderPackagePass, PreparedShaderPackagePass] {
  const [forward, shadow] = passes;
  if (!forward || !shadow) throw new Error("Texture executor omitted a selected forward or shadow pass.");
  return [forward, shadow];
}

export type DeepSlBaseColorTextureProbeRecord = Readonly<{
  action: "deepsl-base-color-texture-package-executor";
  success: boolean;
  textureContract?: Readonly<{
    format: "rgba8unorm-srgb";
    dimensions: readonly [2, 1];
    uvSet: 0;
    transformSource: "runtime-material-uniform";
    materialBytes: 160;
    dummySlots: readonly ["metallicRoughness-linear", "occlusion-linear", "normal-linear", "emissive-srgb"];
  }>;
  gpuReadback?: Readonly<{
    colorFormat: "rgba16float";
    shadowDepthFormat: "depth32float";
    dimensions: readonly [typeof PBR_PROBE_WIDTH, typeof PBR_PROBE_HEIGHT];
  }>;
  cases?: readonly Readonly<{
    id: DeepSlBaseColorTextureCaseId;
    packageCacheKey: string;
    forwardPassCacheKey: string;
    shadowPassCacheKey: string;
    materialParameters: readonly number[];
    raw16: readonly number[];
    pixel: readonly number[];
    shadowDepth: number;
  }>[];
  evaluation?: ReturnType<typeof evaluateBaseColorTextureProbe>;
  failure?: Readonly<{
    stage: "adapter" | "prepare" | "draw-readback" | "evaluate";
    alpha?: "opaque" | "mask";
    message: string;
  }>;
}>;

/** Executes sRGB color, UV0 transform and texture-alpha MASK cases on the real WebGPU device. */
export async function verifyDeepSlBaseColorTexture(device: GPUDevice): Promise<DeepSlBaseColorTextureProbeRecord> {
  const executor = new ShaderPackageExecutor(device);
  const samples: Array<NonNullable<DeepSlBaseColorTextureProbeRecord["cases"]>[number]> = [];
  let stage: NonNullable<DeepSlBaseColorTextureProbeRecord["failure"]>["stage"] = "adapter";
  let alpha: "opaque" | "mask" | undefined;
  let runtimeVariantsSharePreparedPass = true;
  try {
    for (const currentAlpha of ["opaque", "mask"] as const) {
      alpha = currentAlpha;
      stage = "adapter";
      const adapted = adaptBaseColorTextureProbe(currentAlpha, capabilities(device));
      const material = adapted.report.materialDefaults;
      const textureDefaults = adapted.report.materialTextureDefaults;
      if (!adapted.success || !material || !textureDefaults) {
        throw new Error(adapted.report.issues.map((issue) => `${issue.code}: ${issue.message}`).join("; ")
          || "Texture adapter omitted fixed material defaults.");
      }
      const passIds = ["webgpu/forwardCcw", "webgpu/shadowCcw"] as const;
      stage = "prepare";
      const prepared = await executor.prepare(adapted.package, passIds);
      const [forward, shadow] = requirePasses(prepared.passes);
      const parameters = textureDefaults.parameters;
      const translated = translatedBaseColorParameters(parameters, 0.5);
      const variants = currentAlpha === "opaque"
        ? [{ id: "opaque-uv0-left" as const, parameters }, { id: "opaque-runtime-transform" as const, parameters: translated }]
        : [{ id: "mask-alpha-below" as const, parameters }, { id: "mask-alpha-above" as const, parameters: translated }];
      const firstForward = forward;
      const firstShadow = shadow;
      for (const variant of variants) {
        stage = "draw-readback";
        const drawn = await drawDeepSlPbrCase(device, forward, shadow, material, {
          geometry: constantUv0ProbeGeometry(),
          materialTextures: {
            parameters: variant.parameters,
            baseColor: { width: 2, height: 1, data: baseColorProbeTexture() },
          },
        });
        runtimeVariantsSharePreparedPass = runtimeVariantsSharePreparedPass
          && forward === firstForward && shadow === firstShadow;
        samples.push(Object.freeze({
          id: variant.id,
          packageCacheKey: adapted.package.packageCacheKey,
          forwardPassCacheKey: forward.cacheKey,
          shadowPassCacheKey: shadow.cacheKey,
          materialParameters: Object.freeze([...variant.parameters]),
          raw16: drawn.raw16,
          pixel: drawn.pixel,
          shadowDepth: drawn.shadowDepth,
        }));
      }
    }
    stage = "evaluate";
    const evaluation = evaluateBaseColorTextureProbe(samples, runtimeVariantsSharePreparedPass);
    if (!evaluation.verified) throw new Error(`Texture GPU readback failed: ${JSON.stringify(evaluation)}`);
    return Object.freeze({
      action: "deepsl-base-color-texture-package-executor",
      success: true,
      textureContract: Object.freeze({
        format: "rgba8unorm-srgb", dimensions: Object.freeze([2, 1] as const), uvSet: 0,
        transformSource: "runtime-material-uniform", materialBytes: 160,
        dummySlots: Object.freeze([
          "metallicRoughness-linear", "occlusion-linear", "normal-linear", "emissive-srgb",
        ] as const),
      }),
      gpuReadback: Object.freeze({
        colorFormat: "rgba16float", shadowDepthFormat: "depth32float",
        dimensions: Object.freeze([PBR_PROBE_WIDTH, PBR_PROBE_HEIGHT] as const),
      }),
      cases: Object.freeze(samples),
      evaluation,
    });
  } catch (error) {
    return Object.freeze({
      action: "deepsl-base-color-texture-package-executor",
      success: false,
      failure: Object.freeze({
        stage, ...(alpha ? { alpha } : {}),
        message: error instanceof Error ? error.message : String(error),
      }),
    });
  } finally {
    executor.dispose();
  }
}
