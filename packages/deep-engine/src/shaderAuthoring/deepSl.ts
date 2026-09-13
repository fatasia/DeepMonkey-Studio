export const DEEP_SL_SURFACE_EXAMPLE = `shader deep.material {
  surface standard;
  baseColor [0.12, 0.42, 0.9, 1];
  metallic 0.65;
  roughness 0.24;
  alpha opaque;
  doubleSided false;
  baseColorTexture off;
  metallicRoughnessTexture off;
  normalTexture off;
  occlusionTexture off;
  emissiveTexture off;
  baseColorTextureTransform texCoord 0 offset [0, 0] scale [1, 1] rotation 0;
  metallicRoughnessTextureTransform texCoord 0 offset [0, 0] scale [1, 1] rotation 0;
  normalTextureTransform texCoord 0 offset [0, 0] scale [1, 1] rotation 0;
  occlusionTextureTransform texCoord 0 offset [0, 0] scale [1, 1] rotation 0;
  emissiveTextureTransform texCoord 0 offset [0, 0] scale [1, 1] rotation 0;
  normalScale 1;
  occlusionStrength 1;
  emissiveFactor [0, 0, 0];
  emissiveStrength 1;
}`;

export { compileDeepSlSurface, createDeepSlCompiler } from "./deepSlCompiler.js";
export { inspectDeepSlSurface } from "./deepSlParser.js";
export type {
  DeepSlCompilerOptions,
  DeepSlInspection,
  DeepSlSurfaceModel,
  DeepSlTextureTransform,
} from "./deepSlTypes.js";
