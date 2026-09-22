import { sha256Hex } from "../shader/canonical.js";
import type { ShaderGraphAssetV1 } from "./graphTypes.js";

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
}

/** Stable JSON for source control, cache keys and package provenance. */
export function canonicalShaderGraphJson(asset: ShaderGraphAssetV1): string { return canonical(asset); }
export function shaderGraphHash(asset: ShaderGraphAssetV1): string { return sha256Hex(asset); }
export function cloneCanonicalShaderGraph(asset: ShaderGraphAssetV1): ShaderGraphAssetV1 {
  return JSON.parse(canonicalShaderGraphJson(asset)) as ShaderGraphAssetV1;
}
