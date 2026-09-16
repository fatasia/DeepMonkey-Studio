import { inspectDeepSlSurface } from "./deepSlParser.js";
import { adaptDeepSlStandardToShaderPackage } from "./packageAdapter.js";
import { inspectPackageAdapterRequest, rejectedPackageAdapterResult } from "./packageAdapterContract.js";
import type { DeepSlPackageAdapterResult } from "./packageAdapterTypes.js";
import { adaptDeepSlUnlitToShaderPackage } from "./packageUnlitAdapter.js";

/** Safely selects the executable Standard or Unlit adapter from the parsed Surface declaration. */
export function adaptDeepSlToShaderPackage(input: unknown): DeepSlPackageAdapterResult {
  const request = inspectPackageAdapterRequest(input);
  if (!request.value) return rejectedPackageAdapterResult(request.issues);
  const inspected = inspectDeepSlSurface(request.value.source);
  return inspected.success && inspected.model?.surface === "unlit"
    ? adaptDeepSlUnlitToShaderPackage(request.value)
    : adaptDeepSlStandardToShaderPackage(request.value);
}
