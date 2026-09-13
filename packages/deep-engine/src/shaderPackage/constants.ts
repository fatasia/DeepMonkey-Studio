export const DEEP_SHADER_PACKAGE_SCHEMA = "deep-shader-package" as const;
export const DEEP_SHADER_PACKAGE_SCHEMA_VERSION = 2 as const;
export const DEEP_SHADER_TARGET_PROFILE = "webgpu-wgsl-pipeline-2" as const;

export const DEEP_SHADER_PACKAGE_BUDGETS = Object.freeze({
  maxInputNodes: 50_000,
  maxDepth: 24,
  maxIssues: 128,
  maxStringLength: 512,
  maxModules: 128,
  maxPasses: 128,
  maxDependencies: 256,
  maxSourceMapEntriesPerPass: 4_096,
  maxWgslBytesPerModule: 1_048_576,
  maxTotalWgslBytes: 8_388_608,
});
