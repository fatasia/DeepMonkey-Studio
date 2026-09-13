import type { ShaderLightingContextLayoutV1, ShaderStandardSurfaceFields, ShaderValueType } from "./types.js";

export const DEEP_STANDARD_SURFACE_FIELD_TYPES: Readonly<Record<keyof ShaderStandardSurfaceFields, ShaderValueType>> = Object.freeze({
  baseColor: "vec3f",
  normal: "vec3f",
  metallic: "f32",
  roughness: "f32",
  occlusion: "f32",
  emission: "vec3f",
  alpha: "f32",
});

export const DEEP_STANDARD_SURFACE_FIELD_NAMES = Object.freeze(
  Object.keys(DEEP_STANDARD_SURFACE_FIELD_TYPES) as (keyof ShaderStandardSurfaceFields)[],
);

/**
 * Executable compiler/runtime boundary for standard Surface Output. Only bindings
 * 0-6 and the 208-byte frame match deep.pbr.mesh.v1/forward-frame. Generic material
 * bindings and deepVertex/deepFragment still require a package layout adapter.
 */
export const DEEP_STANDARD_LIGHTING_LAYOUT_V1: ShaderLightingContextLayoutV1 = Object.freeze({
  id: "deep-lighting-v1",
  abiVersion: 1,
  frameAbi: "deep.pbr.mesh.v1/forward-frame",
  packageCompatibility: "requires-layout-adapter",
  directLightCapacity: 1,
  worldPositionVarying: "worldPosition",
  dataLayouts: Object.freeze([
    Object.freeze({ id: "frame" as const, byteSize: 208, byteAlignment: 16 as const, members: Object.freeze([
      Object.freeze({ name: "view", type: "mat4x4f" as const, byteOffset: 0, byteSize: 64 }),
      Object.freeze({ name: "light", type: "mat4x4f" as const, byteOffset: 64, byteSize: 64 }),
      Object.freeze({ name: "eye", type: "vec4f" as const, byteOffset: 128, byteSize: 16 }),
      Object.freeze({ name: "background", type: "vec4f" as const, byteOffset: 144, byteSize: 16 }),
      Object.freeze({ name: "floor", type: "vec4f" as const, byteOffset: 160, byteSize: 16 }),
      Object.freeze({ name: "lightDirection", type: "vec4f" as const, byteOffset: 176, byteSize: 16 }),
      Object.freeze({ name: "tuning", type: "vec4f" as const, byteOffset: 192, byteSize: 16 }),
    ]) }),
  ]),
  bindings: Object.freeze([
    Object.freeze({ name: "frame", group: 0, binding: 0, visibility: Object.freeze(["vertex", "fragment"] as const), resource: "uniform-buffer" as const, dataLayout: "frame" as const, minBindingSize: 208 }),
    Object.freeze({ name: "shadowMap", group: 0, binding: 1, visibility: Object.freeze(["fragment"] as const), resource: "texture-depth-2d" as const }),
    Object.freeze({ name: "shadowSampler", group: 0, binding: 2, visibility: Object.freeze(["fragment"] as const), resource: "comparison-sampler" as const }),
    Object.freeze({ name: "specularEnvironment", group: 0, binding: 3, visibility: Object.freeze(["fragment"] as const), resource: "texture-cube-f32" as const }),
    Object.freeze({ name: "diffuseEnvironment", group: 0, binding: 4, visibility: Object.freeze(["fragment"] as const), resource: "texture-cube-f32" as const }),
    Object.freeze({ name: "brdfLut", group: 0, binding: 5, visibility: Object.freeze(["fragment"] as const), resource: "texture-2d-f32" as const }),
    Object.freeze({ name: "environmentSampler", group: 0, binding: 6, visibility: Object.freeze(["fragment"] as const), resource: "sampler" as const }),
  ]),
});

export const DEEP_STANDARD_LIGHTING_CONTEXT_V1 = Object.freeze({
  id: "deep-lighting-v1" as const,
  surfaceModel: "standard-pbr" as const,
  coordinateSpace: "world" as const,
  colorSpace: "linear" as const,
  normalPolicy: "backend-normalizes" as const,
  viewDirectionConvention: "surface-to-camera" as const,
  lightDirectionConvention: "surface-to-light" as const,
  inputs: Object.freeze([
    Object.freeze({ name: "worldPosition" as const, type: "vec3f" as const, cardinality: "one" as const }),
    Object.freeze({ name: "viewDirection" as const, type: "vec3f" as const, cardinality: "one" as const }),
    Object.freeze({ name: "directLights" as const, type: "direct-light-list" as const, cardinality: "one" as const }),
    Object.freeze({ name: "indirectDiffuse" as const, type: "vec3f" as const, cardinality: "one" as const }),
    Object.freeze({ name: "indirectSpecular" as const, type: "vec3f" as const, cardinality: "one" as const }),
  ]),
  directLightFields: Object.freeze([
    Object.freeze({ name: "direction" as const, type: "vec3f" as const }),
    Object.freeze({ name: "radiance" as const, type: "vec3f" as const }),
    Object.freeze({ name: "shadowVisibility" as const, type: "f32" as const }),
  ]),
  implementationLimits: Object.freeze({
    directLightCapacity: 1 as const,
    directRadiance: "engine-calibrated-linear-v1" as const,
    indirectLighting: "prefiltered-environment-and-brdf-lut" as const,
  }),
  compilerSupport: "wgsl-standard-pbr-v1" as const,
  runtimeLayout: DEEP_STANDARD_LIGHTING_LAYOUT_V1,
});
