export type SharedShadowLightKind = "point" | "spot";
export type SharedShadowCubeFace = "+x" | "-x" | "+y" | "-y" | "+z" | "-z";
export type SharedShadowAtlasRejectionReason = "zero-importance" | "light-budget" | "view-budget";

export interface SharedShadowAtlasRequest {
  /** Stable author/runtime identity. */
  readonly key: string;
  readonly kind: SharedShadowLightKind;
  /** Caller-provided screen/lighting importance. Larger values win. */
  readonly importance: number;
}

export interface SharedShadowAtlasLimits {
  readonly maxTextureDimension2D: number;
  readonly maxDepthTextureBytes?: number;
}

export interface SharedShadowAtlasOptions {
  readonly requestedAtlasSize?: number;
  readonly tilesPerAxis?: number;
  readonly maxShadowedLights?: number;
  readonly maxShadowViews?: number;
}

export interface SharedShadowAtlasTile {
  readonly slot: number;
  readonly x: number;
  readonly y: number;
  readonly size: number;
  readonly uvOffset: readonly [number, number];
  readonly uvScale: readonly [number, number];
  readonly face?: SharedShadowCubeFace;
}

export interface SharedShadowAtlasAllocation {
  readonly key: string;
  readonly kind: SharedShadowLightKind;
  readonly importance: number;
  readonly tiles: readonly SharedShadowAtlasTile[];
}

export interface SharedShadowAtlasRejection {
  readonly key: string;
  readonly kind: SharedShadowLightKind;
  readonly requiredViews: number;
  readonly reason: SharedShadowAtlasRejectionReason;
}

export interface SharedShadowAtlasPlan {
  readonly atlasSize: number;
  readonly tileSize: number;
  readonly guardTexels: typeof SHARED_SHADOW_ATLAS_GUARD_TEXELS;
  readonly estimatedDepthTextureBytes: number;
  readonly pcfSampleCount: typeof SHARED_SHADOW_ATLAS_PCF_SAMPLES;
  readonly maxShadowedLights: number;
  readonly maxShadowViews: number;
  readonly allocatedViewCount: number;
  readonly downgraded: boolean;
  readonly allocations: readonly SharedShadowAtlasAllocation[];
  readonly rejected: readonly SharedShadowAtlasRejection[];
}

export const SHARED_SHADOW_ATLAS_PCF_SAMPLES = 4 as const;
export const SHARED_SHADOW_ATLAS_GUARD_TEXELS = 2 as const;
export const DEFAULT_SHARED_SHADOW_ATLAS_SIZE = 4096;
export const DEFAULT_SHARED_SHADOW_ATLAS_TILES_PER_AXIS = 8;
export const DEFAULT_SHARED_SHADOW_ATLAS_MAX_LIGHTS = 16;
export const DEFAULT_SHARED_SHADOW_ATLAS_MAX_VIEWS = 32;
export const DEFAULT_SHARED_SHADOW_ATLAS_DEPTH_BYTES = 64 * 1024 * 1024;

const POINT_FACES = Object.freeze(["+x", "-x", "+y", "-y", "+z", "-z"] as const);

/**
 * Plans the shared local-light depth atlas. The sun remains in the existing
 * cascaded-shadow array; spots cost one view and point lights cost six.
 */
export function planSharedShadowAtlas(requests: readonly SharedShadowAtlasRequest[],
  limits: SharedShadowAtlasLimits, options: SharedShadowAtlasOptions = {}): SharedShadowAtlasPlan {
  validateRequests(requests);
  const validated = validateConfiguration(limits, options);
  const atlasSize = chooseAtlasSize(validated.requestedAtlasSize, validated.maxTextureDimension2D,
    validated.maxDepthTextureBytes, validated.tilesPerAxis);
  const capacity = validated.tilesPerAxis * validated.tilesPerAxis;
  const maxShadowViews = Math.min(validated.maxShadowViews, capacity);
  const ranked = requests.map((request, sourceOrder) => ({ request, sourceOrder }))
    .sort((left, right) => right.request.importance - left.request.importance
      || kindOrder(left.request.kind) - kindOrder(right.request.kind) || left.sourceOrder - right.sourceOrder);
  const allocations: SharedShadowAtlasAllocation[] = [], rejected: SharedShadowAtlasRejection[] = [];
  let nextSlot = 0;

  for (const { request } of ranked) {
    const requiredViews = request.kind === "point" ? POINT_FACES.length : 1;
    let reason: SharedShadowAtlasRejectionReason | undefined;
    if (request.importance === 0) reason = "zero-importance";
    else if (allocations.length >= validated.maxShadowedLights) reason = "light-budget";
    else if (nextSlot + requiredViews > maxShadowViews) reason = "view-budget";
    if (reason) {
      rejected.push(Object.freeze({ key: request.key, kind: request.kind, requiredViews, reason }));
      continue;
    }
    const tiles = Array.from({ length: requiredViews }, (_, faceIndex) => tileFor(nextSlot + faceIndex,
      atlasSize, validated.tilesPerAxis, request.kind === "point" ? POINT_FACES[faceIndex] : undefined));
    nextSlot += requiredViews;
    allocations.push(Object.freeze({ key: request.key, kind: request.kind, importance: request.importance,
      tiles: Object.freeze(tiles) }));
  }

  return Object.freeze({
    atlasSize,
    tileSize: atlasSize / validated.tilesPerAxis,
    guardTexels: SHARED_SHADOW_ATLAS_GUARD_TEXELS,
    estimatedDepthTextureBytes: atlasSize * atlasSize * 4,
    pcfSampleCount: SHARED_SHADOW_ATLAS_PCF_SAMPLES,
    maxShadowedLights: validated.maxShadowedLights,
    maxShadowViews,
    allocatedViewCount: nextSlot,
    downgraded: atlasSize < validated.requestedAtlasSize || maxShadowViews < validated.maxShadowViews,
    allocations: Object.freeze(allocations),
    rejected: Object.freeze(rejected),
  });
}

function tileFor(slot: number, atlasSize: number, tilesPerAxis: number,
  face?: SharedShadowCubeFace): SharedShadowAtlasTile {
  const cellSize = atlasSize / tilesPerAxis;
  const size = cellSize - SHARED_SHADOW_ATLAS_GUARD_TEXELS * 2;
  const x = (slot % tilesPerAxis) * cellSize + SHARED_SHADOW_ATLAS_GUARD_TEXELS;
  const y = Math.floor(slot / tilesPerAxis) * cellSize + SHARED_SHADOW_ATLAS_GUARD_TEXELS;
  return Object.freeze({ slot, x, y, size,
    uvOffset: Object.freeze([x / atlasSize, y / atlasSize]) as readonly [number, number],
    uvScale: Object.freeze([size / atlasSize, size / atlasSize]) as readonly [number, number],
    ...(face ? { face } : {}),
  });
}

function validateRequests(requests: readonly SharedShadowAtlasRequest[]): void {
  if (!Array.isArray(requests)) throw new TypeError("Shadow atlas requests must be an array.");
  const keys = new Set<string>();
  requests.forEach((request, index) => {
    if (!request || typeof request !== "object" || Array.isArray(request)) throw new TypeError(`Invalid shadow request ${index}.`);
    if (typeof request.key !== "string" || request.key.trim().length === 0) throw new TypeError(`Invalid shadow request key ${index}.`);
    if (keys.has(request.key)) throw new Error(`Duplicate shadow request key: ${request.key}.`);
    keys.add(request.key);
    if (request.kind !== "point" && request.kind !== "spot") throw new RangeError(`Invalid shadow light kind: ${String(request.kind)}.`);
    if (!Number.isFinite(request.importance) || request.importance < 0) throw new RangeError(`Invalid shadow importance for ${request.key}.`);
  });
}

function validateConfiguration(limits: SharedShadowAtlasLimits, options: SharedShadowAtlasOptions) {
  if (!limits || typeof limits !== "object" || Array.isArray(limits)) throw new TypeError("Shadow atlas limits must be an object.");
  if (!options || typeof options !== "object" || Array.isArray(options)) throw new TypeError("Shadow atlas options must be an object.");
  const maxTextureDimension2D = positiveInteger(limits.maxTextureDimension2D, "maximum texture dimension");
  const maxDepthTextureBytes = positiveInteger(limits.maxDepthTextureBytes ?? DEFAULT_SHARED_SHADOW_ATLAS_DEPTH_BYTES,
    "maximum depth bytes");
  const requestedAtlasSize = powerOfTwo(options.requestedAtlasSize ?? DEFAULT_SHARED_SHADOW_ATLAS_SIZE, "requested atlas size");
  const tilesPerAxis = powerOfTwo(options.tilesPerAxis ?? DEFAULT_SHARED_SHADOW_ATLAS_TILES_PER_AXIS, "tiles per axis");
  const maxShadowedLights = nonNegativeInteger(options.maxShadowedLights ?? DEFAULT_SHARED_SHADOW_ATLAS_MAX_LIGHTS,
    "maximum shadowed lights");
  const maxShadowViews = nonNegativeInteger(options.maxShadowViews ?? DEFAULT_SHARED_SHADOW_ATLAS_MAX_VIEWS,
    "maximum shadow views");
  return { maxTextureDimension2D, maxDepthTextureBytes, requestedAtlasSize, tilesPerAxis, maxShadowedLights, maxShadowViews };
}

function chooseAtlasSize(requested: number, maxDimension: number, maxBytes: number, tilesPerAxis: number): number {
  const memoryDimension = Math.floor(Math.sqrt(maxBytes / 4));
  let selected = floorPowerOfTwo(Math.min(requested, maxDimension, memoryDimension));
  while (selected >= tilesPerAxis * 64 && selected * selected * 4 > maxBytes) selected /= 2;
  if (selected < tilesPerAxis * 64) {
    throw new RangeError(`Shared shadow atlas requires at least ${tilesPerAxis * 64}px and ${tilesPerAxis * tilesPerAxis * 64 * 64 * 4} depth bytes.`);
  }
  return selected;
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`Invalid shadow atlas ${label}.`);
  return value;
}

function powerOfTwo(value: number, label: string): number {
  positiveInteger(value, label);
  if (!Number.isInteger(Math.log2(value))) throw new RangeError(`Shadow atlas ${label} must be a power of two.`);
  return value;
}

function nonNegativeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`Invalid shadow atlas ${label}.`);
  return value;
}

function floorPowerOfTwo(value: number): number {
  if (value < 1) return 0;
  return 2 ** Math.floor(Math.log2(value));
}

function kindOrder(kind: SharedShadowLightKind): number { return kind === "point" ? 0 : 1; }
