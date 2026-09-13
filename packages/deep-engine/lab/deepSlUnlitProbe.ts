import {
  adaptDeepSlUnlitToShaderPackage, type DeepSlPackageAdapterResult,
} from "@bim-studio/deep-engine/shader-authoring";
import type { ShaderCompileCapabilities } from "@bim-studio/deep-engine/shader";
import { ShaderPackageExecutor, type PreparedShaderPackagePass } from "@bim-studio/deep-engine/webgpu";
import { baseColorProbeTexture } from "./deepSlBaseColorTextureProbeFixture.js";
import { drawDeepSlPbrCase } from "./deepSlPbrGpuDraw.js";
import { pbrProbeGeometry } from "./deepSlPbrProbeFixture.js";

const PLAIN = `shader deep.unlit-probe {
  surface unlit;
  baseColor [0.25, 0.5, 0.75, 1];
  alpha opaque;
  doubleSided false;
  baseColorTexture off;
  emissiveTexture off;
  emissiveFactor [0.1, 0.2, 0.3];
  emissiveStrength 2;
}`;

const TEXTURED_MASK = `shader deep.unlit-probe-textured {
  surface unlit;
  baseColor [0.2, 0.7, 0.25, 1];
  alpha mask;
  doubleSided false;
  baseColorTexture on;
  emissiveTexture on;
  baseColorTextureTransform texCoord 1 offset [0.5, 0] scale [1, 1] rotation 0;
  emissiveTextureTransform texCoord 0 offset [0, 0] scale [1, 1] rotation 0;
  emissiveFactor [0.05, 0.1, 0.2];
  emissiveStrength 2;
}`;

function capabilities(device: GPUDevice): ShaderCompileCapabilities {
  return Object.freeze({ features: Object.freeze([]), limits: Object.freeze({
    maxBindGroups: device.limits.maxBindGroups,
    maxBindingsPerBindGroup: device.limits.maxBindingsPerBindGroup,
    maxInterStageShaderVariables: device.limits.maxInterStageShaderVariables,
  }) });
}

export function adaptUnlitProbeSource(
  source: string, shaderCapabilities: ShaderCompileCapabilities,
): DeepSlPackageAdapterResult {
  return adaptDeepSlUnlitToShaderPackage({
    schemaVersion: 1, source, packageVersion: "1.0.0", compilerVersion: "1.0.0",
    capabilities: shaderCapabilities,
  });
}

function uv1Geometry(): Float32Array {
  const geometry = pbrProbeGeometry();
  for (let vertex = 0; vertex < 3; vertex += 1) {
    geometry[vertex * 10 + 6] = 0.25;
    geometry[vertex * 10 + 7] = 0.5;
    geometry[vertex * 10 + 8] = 0.25;
    geometry[vertex * 10 + 9] = 0.5;
  }
  return geometry;
}

function passes(values: readonly PreparedShaderPackagePass[]) {
  const [forward, shadow] = values;
  if (!forward || !shadow) throw new Error("Unlit probe requires one forward and one shadow pass.");
  return { forward, shadow };
}

export interface DeepSlUnlitSample {
  readonly id: "plain" | "textured-mask";
  readonly pixel: readonly number[];
  readonly shadowDepth: number;
}

export function evaluateUnlitProbe(samples: readonly DeepSlUnlitSample[]) {
  const byId = new Map(samples.map((sample) => [sample.id, sample]));
  const plain = byId.get("plain"), textured = byId.get("textured-mask");
  const finite = samples.length === 2 && byId.size === 2 && samples.every((sample) =>
    sample.pixel.length === 4 && sample.pixel.every(Number.isFinite) && Number.isFinite(sample.shadowDepth));
  const plainUnlit = finite && Boolean(plain
    && Math.abs(plain.pixel[0]! - 0.45) < 0.015
    && Math.abs(plain.pixel[1]! - 0.9) < 0.015
    && Math.abs(plain.pixel[2]! - 1.35) < 0.02
    && Math.abs(plain.pixel[3]! - 1) < 0.005);
  const uv1MaskVisible = finite && Boolean(textured
    && textured.pixel[1]! > textured.pixel[0]! + 0.15
    && textured.pixel[2]! > 0.04
    && Math.abs(textured.pixel[3]! - 1) < 0.005
    && textured.shadowDepth < 0.9);
  const shadowsVisible = finite && Boolean(plain && textured
    && plain.shadowDepth < 0.9 && textured.shadowDepth < 0.9);
  return Object.freeze({ finite, plainUnlit, uv1MaskVisible, shadowsVisible,
    verified: finite && plainUnlit && uv1MaskVisible && shadowsVisible });
}

export type DeepSlUnlitProbeRecord = Readonly<{
  action: "deepsl-unlit-package-executor";
  success: boolean;
  samples?: readonly DeepSlUnlitSample[];
  evaluation?: ReturnType<typeof evaluateUnlitProbe>;
  failure?: Readonly<{ stage: "adapter" | "prepare" | "draw-readback" | "evaluate"; message: string }>;
}>;

/** Proves direct Unlit color/emission and transformed texture MASK on a real WebGPU device. */
export async function verifyDeepSlUnlit(device: GPUDevice): Promise<DeepSlUnlitProbeRecord> {
  const executor = new ShaderPackageExecutor(device);
  const samples: DeepSlUnlitSample[] = [];
  let stage: NonNullable<DeepSlUnlitProbeRecord["failure"]>["stage"] = "adapter";
  try {
    for (const value of [{ id: "plain" as const, source: PLAIN }, { id: "textured-mask" as const, source: TEXTURED_MASK }]) {
      stage = "adapter";
      const adapted = adaptUnlitProbeSource(value.source, capabilities(device));
      if (!adapted.success || !adapted.report.materialDefaults) {
        throw new Error(adapted.report.issues.map((issue) => `${issue.code}: ${issue.message}`).join("; "));
      }
      stage = "prepare";
      const selected = passes((await executor.prepare(adapted.package, [
        "webgpu/forwardCcw", "webgpu/shadowCcw",
      ])).passes);
      stage = "draw-readback";
      const textureDefaults = adapted.report.materialTextureDefaults;
      const drawn = await drawDeepSlPbrCase(device, selected.forward, selected.shadow,
        adapted.report.materialDefaults, textureDefaults ? {
          geometry: uv1Geometry(), materialTextures: {
            parameters: textureDefaults.parameters,
            baseColor: { width: 2, height: 1, data: baseColorProbeTexture() },
            emissive: { width: 1, height: 1, data: new Uint8Array([64, 128, 230, 255]) },
          },
        } : {});
      samples.push(Object.freeze({ id: value.id, pixel: drawn.pixel, shadowDepth: drawn.shadowDepth }));
    }
    stage = "evaluate";
    const evaluation = evaluateUnlitProbe(samples);
    if (!evaluation.verified) throw new Error(`Unlit GPU readback failed: ${JSON.stringify({ samples, evaluation })}`);
    return Object.freeze({ action: "deepsl-unlit-package-executor", success: true,
      samples: Object.freeze(samples), evaluation });
  } catch (error) {
    return Object.freeze({ action: "deepsl-unlit-package-executor", success: false,
      failure: Object.freeze({ stage, message: error instanceof Error ? error.message : String(error) }) });
  } finally { executor.dispose(); }
}
