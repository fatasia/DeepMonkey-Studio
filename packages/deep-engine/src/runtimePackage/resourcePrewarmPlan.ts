import type { DeepShaderPackageV2 } from "../shaderPackage/types.js";
import { orderedRuntimeJson, runtimeContentSha256 } from "./hash.js";
import { RuntimePackageError, snapshotJson } from "./primitives.js";
import {
  DEEP_RUNTIME_PREWARM_LIMITS, DEEP_RUNTIME_PREWARM_SCHEMA, DEEP_RUNTIME_PREWARM_SCHEMA_VERSION,
  type RuntimeResourcePrewarmItem, type RuntimeResourcePrewarmPlan, type RuntimeResourcePrewarmPlanOptions,
  type RuntimeResourcePrewarmResourceItem,
} from "./resourcePrewarmTypes.js";
import type { DeepRuntimePackage, RuntimeJson } from "./types.js";
import { validateDeepRuntimePackage } from "./validation.js";

const RESOURCE_ORDER = Object.freeze({ "ibl-environment": 0, "render-packet": 1,
  "deep2d-runtime": 2, "shader-package": 3, "scene-camera": 4, "chart-runtime": 5, "chart-sim-runtime": 6, "dashboard-runtime": 7, "dynamic-runtime": 8 } as const);

export function buildRuntimeResourcePrewarmPlan(input: unknown,
  options: RuntimeResourcePrewarmPlanOptions = {}): RuntimeResourcePrewarmPlan {
  const validation = validateDeepRuntimePackage(input);
  if (!validation.valid) throw new RuntimePackageError(validation.issues[0]!.path, validation.issues[0]!.message);
  return buildValidatedRuntimeResourcePrewarmPlan(validation.value, options);
}

export function buildValidatedRuntimeResourcePrewarmPlan<TBake = never>(packageValue: DeepRuntimePackage,
  options: RuntimeResourcePrewarmPlanOptions = {},
  render?: Readonly<{ cacheKey: string; evidence: TBake }>): RuntimeResourcePrewarmPlan<TBake> {
  const { maxItems, maxEstimatedBytes } = validateRuntimeResourcePrewarmBudget(options);
  if (packageValue.schemaVersion === 5 && render) {
    throw new RuntimePackageError("$.schemaVersion", "Dashboard resource plans cannot include geometry bake evidence.");
  }
  const renderId = packageValue.entrypoints.renderPacket;
  const entries = [...packageValue.resources].sort((left, right) => RESOURCE_ORDER[left.kind] - RESOURCE_ORDER[right.kind]
    || compare(left.id, right.id));
  const candidates: RuntimeResourcePrewarmItem<TBake>[] = entries.map((entry): RuntimeResourcePrewarmResourceItem<TBake> => ({
    order: -1, type: "resource", cacheKey: `runtime-resource:${entry.kind}:${entry.contentHash.value}`
      + (entry.id === renderId && render ? `:${render.cacheKey}` : ""),
    contentHash: entry.contentHash.value, estimatedBytes: payloadBytes(packageValue.payloads[entry.id]),
    resourceId: entry.id, resourceKind: entry.kind, revision: entry.revision,
    ...(entry.id === renderId && render ? { bake: render.evidence } : {}),
  }));
  for (const shaderId of packageValue.entrypoints.shaderPackages) {
    const shader = packageValue.payloads[shaderId] as unknown as DeepShaderPackageV2;
    const moduleIndex = new Map(shader.modules.map(module => [module.id, module]));
    for (const pass of shader.passes) {
      const module = moduleIndex.get(pass.moduleId);
      if (!module) throw new RuntimePackageError(`$.payloads.${shaderId}.passes`, "Shader pass module is missing.");
      candidates.push({ order: -1, type: "shader-pipeline", cacheKey: `shader-pipeline:${pass.cacheKey}`,
        contentHash: pass.cacheKey, estimatedBytes: new TextEncoder().encode(module.source).byteLength,
        resourceId: shaderId, packageId: shader.packageId, passId: pass.id, techniqueId: pass.techniqueId,
        passKind: pass.kind, moduleId: pass.moduleId, entryPoints: { ...pass.entryPoints }, pipeline: { ...pass.pipeline } });
    }
  }
  const items = candidates.map((candidate, order) => ({ ...candidate, order }));
  const unique = new Map<string, RuntimeResourcePrewarmItem<TBake>>();
  for (const item of items) if (!unique.has(item.cacheKey)) unique.set(item.cacheKey, item);
  const work = [...unique.values()];
  const resourceBytes = work.filter(item => item.type === "resource").reduce((sum, item) => sum + item.estimatedBytes, 0);
  const shaderSourceBytes = work.filter(item => item.type === "shader-pipeline").reduce((sum, item) => sum + item.estimatedBytes, 0);
  const estimatedBytes = resourceBytes + shaderSourceBytes;
  if (work.length > maxItems) throw new RangeError(`Runtime prewarm plan exceeds its item budget (${work.length} > ${maxItems}).`);
  if (estimatedBytes > maxEstimatedBytes) {
    throw new RangeError(`Runtime prewarm plan exceeds its byte budget (${estimatedBytes} > ${maxEstimatedBytes}).`);
  }
  const core = { schema: DEEP_RUNTIME_PREWARM_SCHEMA, schemaVersion: DEEP_RUNTIME_PREWARM_SCHEMA_VERSION,
    packageId: packageValue.packageId, packageHash: packageValue.packageHash.value, items,
    budget: { maxItems, maxEstimatedBytes, candidateItems: candidates.length, plannedItems: work.length,
      deduplicatedItems: candidates.length - work.length, resourceBytes, shaderSourceBytes, estimatedBytes,
      withinLimits: true as const } };
  return freeze(snapshotJson({ ...core, planHash: runtimeContentSha256(core) }) as unknown as RuntimeResourcePrewarmPlan<TBake>);
}

function payloadBytes(value: RuntimeJson | undefined): number {
  if (value === undefined) throw new RuntimePackageError("$.payloads", "Entrypoint payload is missing.");
  return new TextEncoder().encode(orderedRuntimeJson(value)).byteLength;
}
function bounded(value: number | undefined, fallback: number, min: number, max: number, label: string): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < min || result > max) throw new RangeError(`${label} must be an integer from ${min} through ${max}.`);
  return result;
}
function compare(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0; }
function freeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.values(value).forEach(entry => freeze(entry)); Object.freeze(value);
  }
  return value;
}

export const runtimeResourcePrewarmStrategy = Object.freeze({
  buildPlan: buildValidatedRuntimeResourcePrewarmPlan,
  matchesOptions(plan: RuntimeResourcePrewarmPlan, options: RuntimeResourcePrewarmPlanOptions): boolean {
    return plan.budget.maxItems === (options.maxItems ?? DEEP_RUNTIME_PREWARM_LIMITS.items)
      && plan.budget.maxEstimatedBytes === (options.maxEstimatedBytes ?? DEEP_RUNTIME_PREWARM_LIMITS.estimatedBytes);
  },
});

export function validateRuntimeResourcePrewarmBudget(options: RuntimeResourcePrewarmPlanOptions) {
  const maxItems = bounded(options.maxItems, DEEP_RUNTIME_PREWARM_LIMITS.items, 1,
    DEEP_RUNTIME_PREWARM_LIMITS.items, "Runtime prewarm item budget");
  const maxEstimatedBytes = bounded(options.maxEstimatedBytes, DEEP_RUNTIME_PREWARM_LIMITS.estimatedBytes,
    1, DEEP_RUNTIME_PREWARM_LIMITS.estimatedBytes, "Runtime prewarm byte budget");
  return { maxItems, maxEstimatedBytes };
}
