export type RayTracingBackend = "native" | "webgpu" | "unavailable";

export interface RayTracingCapability {
  backend: RayTracingBackend;
  supported: boolean;
  enabled: boolean;
  reason?: string;
}

export function resolveRayTracingCapability(input: {
  backend: RayTracingBackend;
  requested?: boolean;
  supported?: boolean;
}): RayTracingCapability {
  const supported = input.supported === true && input.backend !== "unavailable";
  const enabled = supported && input.requested === true;
  const reason = enabled ? undefined : supported ? "disabled-by-policy" : "hardware-or-backend-unsupported";
  return { backend: enabled ? input.backend : supported ? input.backend : "unavailable", supported, enabled,
    ...(reason === undefined ? {} : { reason }) };
}
