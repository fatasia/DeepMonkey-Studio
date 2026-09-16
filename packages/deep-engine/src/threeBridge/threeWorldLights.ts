import {
  MAX_CLUSTERED_DIRECTIONAL_LIGHTS,
  MAX_CLUSTERED_LOCAL_LIGHTS,
} from "../lighting/clusterPacking.js";
import type {
  WorldClusteredLights,
  WorldDirectionalLight,
  WorldPointLight,
  WorldSpotLight,
} from "../lighting/worldLights.js";
import type { LightVector3, LocalLightShadow } from "../lighting/types.js";

const MAX_TRAVERSED_OBJECTS = 32_768;
const MAX_ISSUES = 32;

export interface ThreeLightObjectSource {
  readonly uuid?: string;
  readonly children: readonly ThreeLightObjectSource[];
  readonly visible: boolean;
  readonly layers: { readonly mask: number };
  readonly matrixWorld: { readonly elements: ArrayLike<number> };
  readonly type: string;
}

export type ThreeFallbackLightRange = number
  | ((light: ThreeLightObjectSource, path: string) => number | undefined);

export interface ThreeWorldLightsOptions {
  readonly cameraLayerMask: number;
  /** Three 的 distance=0 表示无限范围；聚簇光必须由宿主按场景尺度显式收敛。 */
  readonly fallbackRange?: ThreeFallbackLightRange;
}

export interface ThreeLightProjectionIssue {
  readonly code: "unsupported" | "invalid" | "limit";
  readonly path: string;
  readonly type: string;
  readonly feature: string;
  readonly message: string;
}

export type ThreeWorldLightsResult =
  | { readonly ok: true; readonly lights: WorldClusteredLights }
  | { readonly ok: false; readonly issues: readonly ThreeLightProjectionIssue[] };

class LightProjectionFailure extends Error {
  constructor(
    readonly code: ThreeLightProjectionIssue["code"],
    readonly feature: string,
    message: string,
  ) { super(message); }
}

function fail(code: ThreeLightProjectionIssue["code"], feature: string, message: string): never {
  throw new LightProjectionFailure(code, feature, message);
}

function objectRecord(value: unknown, feature: string): Record<string, unknown> {
  if (!value || typeof value !== "object") fail("invalid", feature, `Three ${feature} must be an object.`);
  return value as Record<string, unknown>;
}

function finiteNonnegative(value: unknown, feature: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    fail("invalid", feature, `Three ${feature} must be finite and nonnegative.`);
  }
  return value;
}

function frozenVector(x: number, y: number, z: number): LightVector3 {
  return Object.freeze([x, y, z] as const);
}

function worldPosition(value: unknown, feature: string): LightVector3 {
  const matrix = objectRecord(objectRecord(value, feature).matrixWorld, `${feature}.matrixWorld`).elements;
  if (!matrix || typeof matrix !== "object" || (matrix as ArrayLike<number>).length !== 16) {
    fail("invalid", feature, `Three ${feature}.matrixWorld must contain 16 values.`);
  }
  const elements = matrix as ArrayLike<number>;
  const x = elements[12], y = elements[13], z = elements[14];
  if (![x, y, z].every(value => typeof value === "number" && Number.isFinite(value))) {
    fail("invalid", feature, `Three ${feature} world position must be finite.`);
  }
  return frozenVector(x as number, y as number, z as number);
}

function lightDirection(light: Record<string, unknown>, position: LightVector3): LightVector3 {
  const target = worldPosition(light.target, "light.target");
  const x = target[0] - position[0], y = target[1] - position[1], z = target[2] - position[2];
  const length = Math.hypot(x, y, z);
  if (!Number.isFinite(length) || length < 1e-8) {
    fail("invalid", "light direction", "Three light and target world positions must differ.");
  }
  return frozenVector(x / length, y / length, z / length);
}

function lightColor(light: Record<string, unknown>): LightVector3 {
  const color = objectRecord(light.color, "light.color");
  return frozenVector(
    finiteNonnegative(color.r, "light.color.r"),
    finiteNonnegative(color.g, "light.color.g"),
    finiteNonnegative(color.b, "light.color.b"),
  );
}

function lightRange(
  source: ThreeLightObjectSource,
  light: Record<string, unknown>,
  path: string,
  fallback: ThreeFallbackLightRange | undefined,
): number {
  const distance = finiteNonnegative(light.distance, "light.distance");
  if (distance > 0) return distance;
  if (fallback === undefined) {
    fail("unsupported", "light range", "Three distance=0 requires an explicit positive fallbackRange for bounded clustering.");
  }
  const range = typeof fallback === "function" ? fallback(source, path) : fallback;
  if (typeof range !== "number" || !Number.isFinite(range) || range <= 0) {
    fail("invalid", "fallbackRange", "Three fallbackRange must resolve to a finite positive value.");
  }
  return range;
}

function nextFloat32(value: number): number {
  const numbers = new Float32Array([value]);
  const bits = new Uint32Array(numbers.buffer);
  bits[0] = bits[0]! + 1;
  return numbers[0]!;
}

function spotCones(light: Record<string, unknown>): readonly [number, number] {
  const angle = light.angle, penumbra = light.penumbra;
  if (typeof angle !== "number" || !Number.isFinite(angle) || angle <= 0 || angle > Math.PI / 2) {
    fail("invalid", "spot angle", "Three spot angle must be finite and inside (0, PI / 2].");
  }
  if (typeof penumbra !== "number" || !Number.isFinite(penumbra) || penumbra < 0 || penumbra > 1) {
    fail("invalid", "spot penumbra", "Three spot penumbra must be finite and inside [0, 1].");
  }
  const outer = Math.fround(Math.cos(angle));
  let inner = Math.fround(Math.cos(angle * (1 - penumbra)));
  // Deep 的固定 ABI 要求正锥宽；用一个 float32 ULP 表达 Three 的硬边并避免除零。
  if (inner <= outer) inner = nextFloat32(outer);
  if (!Number.isFinite(inner) || inner > 1) {
    fail("invalid", "spot cone", "Three spot cone is narrower than the float32 lighting ABI can represent.");
  }
  return Object.freeze([inner, outer] as const);
}

function common(light: Record<string, unknown>): { readonly color: LightVector3; readonly intensity: number } {
  return Object.freeze({ color: lightColor(light), intensity: finiteNonnegative(light.intensity, "light.intensity") });
}

function localShadow(source: ThreeLightObjectSource, light: Record<string, unknown>, supported: boolean): LocalLightShadow | undefined {
  if (light.castShadow !== true) return undefined;
  if (!supported) fail("unsupported", "light shadows", "Only Three spot-light shadows map to the Deep local shadow atlas.");
  const uuid = source.uuid;
  if (typeof uuid !== "string" || !/^[0-9A-Za-z][0-9A-Za-z._:-]{0,121}$/.test(uuid)) {
    fail("invalid", "light shadow identity", "Three shadow-casting spot lights require a bounded stable uuid.");
  }
  return Object.freeze({ key: `three:${uuid}` });
}

function localCommon(
  source: ThreeLightObjectSource,
  light: Record<string, unknown>,
  path: string,
  fallback: ThreeFallbackLightRange | undefined,
  shadowSupported = false,
): WorldPointLight {
  if (light.decay !== 2) fail("unsupported", "light decay", "Deep clustered lights currently require Three decay=2.");
  const shadow = localShadow(source, light, shadowSupported);
  return Object.freeze({
    ...common(light),
    positionWorld: worldPosition(source, "light"),
    range: lightRange(source, light, path, fallback),
    ...(shadow ? { shadow } : {}),
  });
}

function appendLight(
  source: ThreeLightObjectSource,
  path: string,
  fallback: ThreeFallbackLightRange | undefined,
  directional: WorldDirectionalLight[],
  points: WorldPointLight[],
  spots: WorldSpotLight[],
): void {
  const light = source as unknown as Record<string, unknown>;
  if (light.isDirectionalLight === true) {
    localShadow(source, light, false);
    const position = worldPosition(source, "light");
    directional.push(Object.freeze({ ...common(light), directionWorld: lightDirection(light, position) }));
  } else if (light.isSpotLight === true) {
    if (light.map != null) fail("unsupported", "spot map", "Three spot texture maps require a light-cookie bridge.");
    const base = localCommon(source, light, path, fallback, true), [innerConeCos, outerConeCos] = spotCones(light);
    spots.push(Object.freeze({ ...base, directionWorld: lightDirection(light, base.positionWorld), innerConeCos, outerConeCos }));
  } else if (light.isPointLight === true) {
    points.push(localCommon(source, light, path, fallback));
  } else {
    fail("unsupported", `light type ${source.type}`, `Visible Three light type ${source.type} is not supported by clustered lighting.`);
  }
}

/** Reads already-updated Three world matrices without invoking author lifecycle methods. */
export function projectThreeWorldLights(
  root: ThreeLightObjectSource,
  options: ThreeWorldLightsOptions,
): ThreeWorldLightsResult {
  const directional: WorldDirectionalLight[] = [], points: WorldPointLight[] = [], spots: WorldSpotLight[] = [];
  const issues: ThreeLightProjectionIssue[] = [], seen = new Set<ThreeLightObjectSource>();
  const stack = [{ source: root, path: "root" }];
  if (!Number.isInteger(options.cameraLayerMask)
    || options.cameraLayerMask < -2_147_483_648 || options.cameraLayerMask > 4_294_967_295) {
    return { ok: false, issues: Object.freeze([{ code: "invalid", path: "cameraLayerMask", type: "", feature: "camera layers", message: "Invalid Three camera layer mask." }]) };
  }
  while (stack.length && issues.length < MAX_ISSUES) {
    const { source, path } = stack.pop()!;
    try {
      if (seen.has(source)) fail("invalid", "object tree", "Three light tree contains a cycle or duplicate child.");
      seen.add(source);
      if (seen.size > MAX_TRAVERSED_OBJECTS) fail("limit", "objects", `Three light traversal exceeds ${MAX_TRAVERSED_OBJECTS} objects.`);
      if (typeof source.visible !== "boolean" || !Array.isArray(source.children)) fail("invalid", "object", "Malformed Three light tree object.");
      if (!source.visible) continue;
      const mask = source.layers?.mask;
      if (!Number.isInteger(mask)) fail("invalid", "object layers", "Three object layer mask must be an integer.");
      const object = source as unknown as Record<string, unknown>;
      if (object.isLight === true && ((mask as number) & options.cameraLayerMask) !== 0) {
        appendLight(source, path, options.fallbackRange, directional, points, spots);
      }
      for (let index = source.children.length - 1; index >= 0; index--) {
        stack.push({ source: source.children[index]!, path: `${path}.children[${index}]` });
      }
    } catch (error) {
      const failure = error instanceof LightProjectionFailure
        ? error
        : new LightProjectionFailure("invalid", "light", error instanceof Error ? error.message : "Invalid Three light source.");
      issues.push(Object.freeze({ code: failure.code, path, type: source?.type ?? "", feature: failure.feature, message: failure.message }));
    }
  }
  if (directional.length > MAX_CLUSTERED_DIRECTIONAL_LIGHTS) {
    issues.push(Object.freeze({ code: "limit", path: "root", type: root.type, feature: "directional lights", message: `Directional light count exceeds ${MAX_CLUSTERED_DIRECTIONAL_LIGHTS}.` }));
  }
  if (points.length + spots.length > MAX_CLUSTERED_LOCAL_LIGHTS) {
    issues.push(Object.freeze({ code: "limit", path: "root", type: root.type, feature: "local lights", message: `Local light count exceeds ${MAX_CLUSTERED_LOCAL_LIGHTS}.` }));
  }
  if (issues.length) return { ok: false, issues: Object.freeze(issues.slice(0, MAX_ISSUES)) };
  return { ok: true, lights: Object.freeze({
    directional: Object.freeze(directional), points: Object.freeze(points), spots: Object.freeze(spots),
  }) };
}
