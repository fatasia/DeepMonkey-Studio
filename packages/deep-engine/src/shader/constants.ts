import type { ShaderScope } from "./types.js";

export const DEEP_SHADER_BUDGETS = Object.freeze({
  maxInputNodes: 20_000,
  maxDepth: 32,
  maxIssues: 128,
  maxStringLength: 512,
  maxProperties: 128,
  maxResources: 64,
  maxAttributes: 32,
  maxVaryings: 24,
  maxKeywords: 24,
  maxTechniques: 16,
  maxPasses: 64,
  maxNodesPerStage: 512,
  maxRawKeywordCombinations: 4_096,
  maxVariants: 128,
});

export const SHADER_SCOPE_GROUP: Readonly<Record<ShaderScope, number>> = Object.freeze({
  frame: 0,
  material: 1,
  object: 2,
  pass: 3,
});

export const IDENTIFIER = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
export const ASSET_ID = /^[a-z][a-z0-9.-]{0,127}$/;
