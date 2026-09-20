import type { FrameCaptureSourceMapRef } from "../r12/frameCapture.js";
import { sha256Utf8 } from "../shaderPackage/hash.js";

export interface PbrOutputShaderProvenance {
  /** Only the pipeline created with this exact WGSL can request these references. */
  refsFor(pipeline: GPURenderPipeline): readonly FrameCaptureSourceMapRef[];
}

/** Entry-point locations in generated WGSL, not author graph nodes or TypeScript source lines. */
export function createPbrOutputShaderProvenance(pipeline: GPURenderPipeline, code: string): PbrOutputShaderProvenance {
  let refs: readonly FrameCaptureSourceMapRef[] | undefined;
  return Object.freeze({ refsFor(actual: GPURenderPipeline) {
    if (actual !== pipeline) throw new Error("PBR output shader provenance does not match the executed pipeline.");
    if (refs) return refs;
    if (code.length > 1_048_576) throw new Error("PBR output shader source exceeds capture budget.");
    const moduleId = `builtin.pbr-output.sha256-${sha256Utf8(code)}`;
    refs = Object.freeze((["vertex", "fragment"] as const).map(stage => {
      const entryPoint = `${stage}Main`;
      const pattern = new RegExp(`@${stage}\\s+fn\\s+${entryPoint}\\b`, "g");
      const matches = [...code.matchAll(pattern)];
      if (matches.length !== 1) throw new Error(`PBR output shader requires one ${entryPoint} entry point.`);
      return Object.freeze({ moduleId, stage, nodeId: `wgsl.entrypoint.${entryPoint}`,
        generatedLine: code.slice(0, matches[0]!.index).split("\n").length });
    }));
    return refs;
  } });
}
