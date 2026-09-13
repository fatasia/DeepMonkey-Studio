import { requireValue } from "./primitives.js";
import { orderedRuntimeJson } from "./hash.js";
import { parseUniqueRuntimeJson } from "./jsonInput.js";
import { DEEP_RUNTIME_PACKAGE_BUDGETS, type RuntimeJson, type RuntimePackageValidation } from "./types.js";
import { validateDeepRuntimePackage } from "./validation.js";

export function serializeDeepRuntimePackage(input: unknown): string {
  const result = validateDeepRuntimePackage(input);
  if (!result.valid) throw new Error(result.issues[0]?.message ?? "Invalid runtime package.");
  const text = orderedRuntimeJson(result.value as unknown as RuntimeJson);
  requireValue(new TextEncoder().encode(text).length <= DEEP_RUNTIME_PACKAGE_BUDGETS.inputBytes, "$", "Serialized package exceeds 256 MiB.");
  return text;
}
export function parseDeepRuntimePackage(input: string | Uint8Array): RuntimePackageValidation {
  try {
    const length = typeof input === "string" ? new TextEncoder().encode(input).length : input.byteLength;
    requireValue(length <= DEEP_RUNTIME_PACKAGE_BUDGETS.inputBytes, "$", "Package exceeds 256 MiB.");
    const text = typeof input === "string" ? input : new TextDecoder("utf-8", { fatal: true }).decode(input);
    return validateDeepRuntimePackage(parseUniqueRuntimeJson(text));
  } catch (error) { return { valid: false, issues: [{ path: "$", message: error instanceof Error ? error.message : "Invalid package JSON." }] }; }
}
