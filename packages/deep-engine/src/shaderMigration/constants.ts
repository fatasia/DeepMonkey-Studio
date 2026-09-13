import type { ShaderMigrationFacet, ShaderSourceKind } from "./types.js";

export const SHADER_MIGRATION_FACETS: readonly ShaderMigrationFacet[] = Object.freeze([
  "properties",
  "render-state",
  "passes",
  "surface-features",
  "vertex-deformation",
  "keywords-variants",
  "custom-code",
  "compute",
  "source-mapping",
]);

export const SHADER_SOURCE_KINDS: readonly ShaderSourceKind[] = Object.freeze([
  "unity-standard",
  "unity-urp-lit",
  "unity-unlit",
  "unity-simple-lit",
  "unity-hdrp-lit",
  "unity-shader-graph",
  "unity-shaderlab-hlsl",
  "three-mesh-standard",
  "three-mesh-physical",
  "three-shader-material",
  "three-on-before-compile",
  "three-tsl",
]);

export const SHADER_MIGRATION_MAX_NODES = 2_048;
export const SHADER_MIGRATION_MAX_DEPTH = 8;
export const SHADER_MIGRATION_MAX_ARRAY_ITEMS = 512;
export const SHADER_MIGRATION_MAX_DIAGNOSTICS = 128;

export const DIRECT_TEMPLATE_SOURCES = new Set<ShaderSourceKind>([
  "unity-standard",
  "unity-urp-lit",
  "unity-unlit",
  "unity-simple-lit",
  "unity-hdrp-lit",
  "three-mesh-standard",
  "three-mesh-physical",
]);

export const GRAPH_TRANSLATE_SOURCES = new Set<ShaderSourceKind>([
  "unity-shader-graph",
  "three-tsl",
]);
