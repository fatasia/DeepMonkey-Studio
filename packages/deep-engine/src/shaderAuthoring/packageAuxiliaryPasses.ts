import type { DeepWgslModuleDescriptor } from "../shader/types.js";
import type { ShaderPackagePassBuildInput } from "../shaderPackage/types.js";
import type { DeepSlPackagePassCompatibility } from "./packageAdapterTypes.js";

export interface AuxiliaryPackageOptions {
  readonly alpha: "opaque" | "mask" | "blend";
  readonly doubleSided: boolean;
  readonly textured: boolean;
  readonly uvFunction: "deepPackageSlotUv" | "deepUnlitUv";
}

function auxiliaryWgsl(options: AuxiliaryPackageOptions): string {
  const uvFields = options.textured
    ? "@location(10) uv0: vec2f,\n  @location(13) uv1: vec2f," : "";
  const uvOutputs = options.textured
    ? "@location(1) uv0: vec2f,\n  @location(2) uv1: vec2f," : "";
  const copyUv = options.textured ? "output.uv0 = input.uv0; output.uv1 = input.uv1;" : "";
  const sampledAlpha = options.textured ? /* wgsl */ `
  var alpha = input.alphaCutoff.x;
  if (deepMaterialTextures.baseRow0.w > 0.5) {
    alpha *= textureSample(deepBaseColorMap, deepBaseColorSampler,
      ${options.uvFunction}(input.uv0, input.uv1,
        deepMaterialTextures.baseRow0, deepMaterialTextures.baseRow1)).a;
  }
  if (alpha < input.alphaCutoff.y) { discard; }` :
    "if (input.alphaCutoff.x < input.alphaCutoff.y) { discard; }";
  return /* wgsl */ `
struct DeepAuxPositionInput {
  @location(0) position: vec3f,
  @location(2) modelRow0: vec4f,
  @location(3) modelRow1: vec4f,
  @location(4) modelRow2: vec4f,
  @location(14) objectId: vec4f,
};
fn deepAuxWorld(position: vec3f, row0: vec4f, row1: vec4f, row2: vec4f) -> vec3f {
  let point = vec4f(position, 1.0);
  return vec3f(dot(row0, point), dot(row1, point), dot(row2, point));
}
@vertex fn depthMain(input: DeepAuxPositionInput) -> @builtin(position) vec4f {
  return deepPbrFrame.view * vec4f(deepAuxWorld(
    input.position, input.modelRow0, input.modelRow1, input.modelRow2), 1.0);
}
struct DeepAuxPickingOutput {
  @builtin(position) position: vec4f,
  @location(0) @interpolate(flat) objectId: vec4f,
};
@vertex fn pickingMain(input: DeepAuxPositionInput) -> DeepAuxPickingOutput {
  var output: DeepAuxPickingOutput;
  output.position = deepPbrFrame.view * vec4f(deepAuxWorld(
    input.position, input.modelRow0, input.modelRow1, input.modelRow2), 1.0);
  output.objectId = input.objectId;
  return output;
}
@fragment fn pickingPlain(input: DeepAuxPickingOutput) -> @location(0) vec4f {
  return input.objectId;
}
struct DeepAuxMaskInput {
  @location(0) position: vec3f,
  @location(2) modelRow0: vec4f,
  @location(3) modelRow1: vec4f,
  @location(4) modelRow2: vec4f,
  @location(9) material: vec4f,
  ${uvFields}
  @location(12) emissiveAlpha: vec4f,
  @location(14) objectId: vec4f,
};
struct DeepAuxDepthMaskOutput {
  @builtin(position) position: vec4f,
  @location(0) alphaCutoff: vec2f,
  ${uvOutputs}
};
@vertex fn depthMaskMain(input: DeepAuxMaskInput) -> DeepAuxDepthMaskOutput {
  var output: DeepAuxDepthMaskOutput;
  output.position = deepPbrFrame.view * vec4f(deepAuxWorld(
    input.position, input.modelRow0, input.modelRow1, input.modelRow2), 1.0);
  output.alphaCutoff = vec2f(input.emissiveAlpha.a, input.material.y);
  ${copyUv}
  return output;
}
@fragment fn ${options.textured ? "depthMaskTextured" : "depthMaskPlain"}(input: DeepAuxDepthMaskOutput) {
  ${sampledAlpha}
}
struct DeepAuxPickingMaskOutput {
  @builtin(position) position: vec4f,
  @location(0) alphaCutoff: vec2f,
  ${uvOutputs}
  @location(3) @interpolate(flat) objectId: vec4f,
};
@vertex fn pickingMaskMain(input: DeepAuxMaskInput) -> DeepAuxPickingMaskOutput {
  var output: DeepAuxPickingMaskOutput;
  output.position = deepPbrFrame.view * vec4f(deepAuxWorld(
    input.position, input.modelRow0, input.modelRow1, input.modelRow2), 1.0);
  output.alphaCutoff = vec2f(input.emissiveAlpha.a, input.material.y);
  ${copyUv}
  output.objectId = input.objectId;
  return output;
}
@fragment fn ${options.textured ? "pickingMaskTextured" : "pickingMaskPlain"}(
  input: DeepAuxPickingMaskOutput,
) -> @location(0) vec4f {
  ${sampledAlpha}
  return input.objectId;
}
`;
}

export function appendAuxiliaryWgsl(
  module: DeepWgslModuleDescriptor,
  options: AuxiliaryPackageOptions,
): DeepWgslModuleDescriptor {
  return Object.freeze({ label: `${module.label}/aux-v3`, code: module.code + auxiliaryWgsl(options) });
}

export function packageAuxiliaryPasses(
  module: DeepWgslModuleDescriptor,
  options: AuxiliaryPackageOptions,
): { readonly builds: ShaderPackagePassBuildInput[]; readonly reports: DeepSlPackagePassCompatibility[] } {
  const modes = options.doubleSided ? ["double" as const] : ["ccw" as const, "cw" as const];
  const builds: ShaderPackagePassBuildInput[] = [], reports: DeepSlPackagePassCompatibility[] = [];
  const add = (pass: Omit<ShaderPackagePassBuildInput, "techniqueId" | "module" | "sourceMap">): void => {
    const build = { techniqueId: "webgpu", module: { ...module }, sourceMap: [], ...pass };
    builds.push(build);
    reports.push(Object.freeze({ passId: pass.passId, kind: pass.kind,
      entryPoints: Object.freeze({ ...pass.entryPoints }), pipeline: Object.freeze({ ...pass.pipeline }) }));
  };
  for (const rasterMode of modes) {
    const suffix = rasterMode === "double" ? "Double" : rasterMode === "ccw" ? "Ccw" : "Cw";
    const masked = options.alpha === "mask";
    if (options.alpha !== "blend") add({
      passId: `depth${suffix}`, kind: "depth",
      entryPoints: masked
        ? { vertex: "depthMaskMain", fragment: options.textured ? "depthMaskTextured" : "depthMaskPlain" }
        : { vertex: "depthMain", fragment: null },
      pipeline: { passVariantId: masked
        ? options.textured ? "depth-mask-material" : "depth-mask-plain" : "depth-solid",
      attachmentProfileId: "depth", alphaMode: masked ? "MASK" : "OPAQUE", rasterMode },
    });
    add({
      passId: `picking${suffix}`, kind: "picking",
      entryPoints: masked
        ? { vertex: "pickingMaskMain", fragment: options.textured ? "pickingMaskTextured" : "pickingMaskPlain" }
        : { vertex: "pickingMain", fragment: "pickingPlain" },
      pipeline: { passVariantId: masked
        ? options.textured ? "picking-mask-material" : "picking-mask-plain" : "picking-solid",
      attachmentProfileId: "picking", alphaMode: masked ? "MASK"
        : options.alpha === "blend" ? "BLEND" : "OPAQUE", rasterMode },
    });
  }
  return { builds, reports };
}
