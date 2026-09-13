import type { ShaderCompileCapabilities } from "@bim-studio/deep-engine/shader";

export const TEST_CAPABILITIES: ShaderCompileCapabilities = Object.freeze({
  features: Object.freeze([]),
  limits: Object.freeze({ maxBindGroups: 4, maxBindingsPerBindGroup: 16, maxInterStageShaderVariables: 16 }),
});
