import type { ResidencyBudgets, ResidencyRequest, StreamedResourceProfile } from "./types.js";

export const DEEP_RESIDENCY_LIMITS = Object.freeze({
  maxBytes: 16 * 1024 * 1024 * 1024,
  maxResources: 1_000_000,
  maxLevels: 32,
  maxRetainFrames: 10_000,
  maxPriority: 1_000_000,
});

function integer(value: number, minimum: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${label} must be an integer from ${minimum} through ${maximum}.`);
  }
  return value;
}

export function validateBudgets(input: ResidencyBudgets): Required<ResidencyBudgets> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new TypeError("Residency budgets must be an object.");
  const maxResidentBytes = integer(input.maxResidentBytes, 1, DEEP_RESIDENCY_LIMITS.maxBytes, "Resident byte budget");
  const maxUploadBytesPerFrame = integer(input.maxUploadBytesPerFrame, 1, maxResidentBytes, "Upload byte budget");
  return Object.freeze({
    maxResidentBytes,
    maxUploadBytesPerFrame,
    maxResources: integer(input.maxResources ?? 65_536, 1, DEEP_RESIDENCY_LIMITS.maxResources, "Resource budget"),
    retainFrames: integer(input.retainFrames ?? 2, 0, DEEP_RESIDENCY_LIMITS.maxRetainFrames, "Retention frame count"),
  });
}

export function validateProfile(input: StreamedResourceProfile): Readonly<StreamedResourceProfile> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new TypeError("Resource profile must be an object.");
  if (typeof input.id !== "string" || !input.id.trim() || input.id.length > 256) throw new TypeError("Resource id is invalid.");
  integer(input.revision, 0, Number.MAX_SAFE_INTEGER, "Resource revision");
  if (input.kind !== "geometry" && input.kind !== "texture") throw new TypeError("Resource kind is invalid.");
  if (!Array.isArray(input.levels) || input.levels.length < 1 || input.levels.length > DEEP_RESIDENCY_LIMITS.maxLevels) {
    throw new RangeError(`Resource levels must contain 1-${DEEP_RESIDENCY_LIMITS.maxLevels} entries.`);
  }
  let previousBytes = Number.POSITIVE_INFINITY;
  const levels = input.levels.map((level, index) => {
    if (!level || typeof level !== "object" || Array.isArray(level)) throw new TypeError(`Resource level ${index} is invalid.`);
    if (level.level !== index) throw new RangeError("Resource levels must use contiguous zero-based indices.");
    const byteLength = integer(level.byteLength, 1, DEEP_RESIDENCY_LIMITS.maxBytes, `Resource level ${index} bytes`);
    if (byteLength > previousBytes) throw new RangeError("Coarser resource levels must not use more bytes than finer levels.");
    previousBytes = byteLength;
    return Object.freeze({ level: index, byteLength });
  });
  return Object.freeze({ id: input.id, revision: input.revision, kind: input.kind, levels: Object.freeze(levels) });
}

export interface ValidatedRequest {
  readonly id: string;
  readonly desiredLevel: number;
  readonly priority: number;
  readonly required: boolean;
}

export function validateRequests(input: readonly ResidencyRequest[], profiles: ReadonlyMap<string, Readonly<StreamedResourceProfile>>,
  maximum: number): readonly ValidatedRequest[] {
  if (!Array.isArray(input) || input.length > maximum) throw new RangeError("Residency request count exceeds its resource budget.");
  const ids = new Set<string>();
  return Object.freeze(input.map((request) => {
    if (!request || typeof request !== "object" || Array.isArray(request) || typeof request.id !== "string") {
      throw new TypeError("Residency request is invalid.");
    }
    if (ids.has(request.id)) throw new Error(`Duplicate residency request: ${request.id}.`);
    ids.add(request.id);
    const profile = profiles.get(request.id);
    if (!profile) throw new Error(`Unknown streamed resource: ${request.id}.`);
    const desiredLevel = integer(request.desiredLevel, 0, profile.levels.length - 1, `Desired level for ${request.id}`);
    const priority = request.priority ?? 0;
    if (!Number.isFinite(priority) || Math.abs(priority) > DEEP_RESIDENCY_LIMITS.maxPriority) {
      throw new RangeError(`Priority for ${request.id} is invalid.`);
    }
    if (request.required !== undefined && typeof request.required !== "boolean") throw new TypeError(`Required flag for ${request.id} is invalid.`);
    return Object.freeze({ id: request.id, desiredLevel, priority, required: request.required ?? false });
  }));
}
