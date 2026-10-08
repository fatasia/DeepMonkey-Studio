import { STOCK_MATERIAL_INSTANCE_OPTIONS } from "../materialInstanceAbi.js";
import { prepareRenderPacket } from "../renderPacket.js";
import { hashOwnedRuntimeJson, orderedRuntimeJson, runtimeContentSha256, runtimePackageSha256 } from "./hash.js";
import { normalizeRuntimeMaterialBindings } from "./materialBindings.js";
import { record, requireValue, snapshotJson } from "./primitives.js";
import { assertNativePacketDeformationSupported, normalizeRuntimeRenderPacket, validateRuntimeRenderPacket } from "./renderPacket.js";
import { compactRuntimePacketTextures } from "./renderPacketTextureBytes.js";
import { BUILTIN_RUNTIME_IBL_ID, validateDeepRuntimePackage, validateOwnedBuiltRuntimePackage } from "./validation.js";
import { validateRuntimeStaticLightmapBinding } from "./environment.js";
import { DEEP_RUNTIME_PACKAGE_BUDGETS, DEEP_RUNTIME_PACKAGE_SCHEMA, DEEP_RUNTIME_PACKAGE_SCHEMA_VERSION, DEEP_RUNTIME_PACKAGE_SHADER_BINDINGS_VERSION, DEEP_RUNTIME_PACKAGE_CAMERA_VERSION, DEEP_RUNTIME_PACKAGE_CHART_VERSION, DEEP_RUNTIME_PACKAGE_DYNAMIC_VERSION,
  type BuildDeepRuntimePackageInput, type DeepRuntimePackage, type RuntimeJson,
  type RuntimeResourceIndexEntry, type RuntimeResourceKind } from "./types.js";

export function buildDeepRuntimePackage(input: BuildDeepRuntimePackageInput): DeepRuntimePackage {
  const draft = createOwnedRuntimePackageCore(input);
  const core = { ...draft, resources: draft.resources.map(resource => ({ ...resource,
    contentHash: { algorithm: "sha256" as const, value: runtimeContentSha256(draft.payloads[resource.id]) } })) };
  const result = validateDeepRuntimePackage({ ...core, packageHash: { algorithm: "sha256", value: runtimePackageSha256(core) } });
  if (!result.valid) throw new Error(result.issues[0]?.message ?? "Invalid runtime package.");
  return result.value;
}

function createOwnedRuntimePackageCore(input: BuildDeepRuntimePackageInput) {
  assertNativePacketDeformationSupported(input.renderPacket.value);
  // Three keeps world matrices in Float64 until packet validation. Runtime JSON has no typed-array
  // identity, so normalize only that authoring representation before taking the immutable snapshot.
  // 节点级拾取映射只住在作者面 RenderPacket:提升到包顶层后从 payload 剥离,
  // render-packet payload 保持 Native 契约的精确字段集(拒绝未知字段)。
  const { objectBindings, ...packetValue } = input.renderPacket.value;
  const packetSource = { ...packetValue, instances: packetValue.instances.map(instance => ({
    ...instance, transform: instance.transform instanceof Float64Array ? Array.from(instance.transform) : instance.transform,
  })) };
  const packet = record(snapshotJson(compactRuntimePacketTextures(packetSource), true), "$.renderPacket");
  validateRuntimeRenderPacket(packet, "$.renderPacket");
  prepareRenderPacket(input.renderPacket.value, STOCK_MATERIAL_INSTANCE_OPTIONS);
  normalizeRuntimeRenderPacket(packet);
  const payloads: Record<string, RuntimeJson> = Object.create(null), resources: RuntimeResourceIndexEntry[] = [];
  const add = (id: string, revision: number, kind: RuntimeResourceKind, value: unknown, owned = false): void => {
    requireValue(!Object.hasOwn(payloads, id), "$.resources", `Duplicate resource id: ${id}.`);
    const payload = owned ? value as RuntimeJson : snapshotJson(value);
    payloads[id] = payload;
    resources.push({ id, revision, kind, contentHash: { algorithm: "sha256", value: "" } });
  };
  add(input.renderPacket.id, input.renderPacket.revision, "render-packet", packet, true);
  const environment = input.environment ?? {
    schema: "deep-engine.ibl-reference", schemaVersion: 1, id: BUILTIN_RUNTIME_IBL_ID, revision: 1, kind: "builtin-default",
  };
  validateRuntimeStaticLightmapBinding(environment, packet, "$.environment");
  add(environment.id, environment.revision, "ibl-environment", environment);
  if (input.camera) add(input.camera.id, input.camera.revision, "scene-camera", input.camera);
  if (input.deep2d) add(input.deep2d.id, input.deep2d.revision, "deep2d-runtime", input.deep2d);
  const chartPayload = input.chart ? {
    schema: "deep-engine.chart-runtime", schemaVersion: 1,
    id: input.chart.id, revision: input.chart.revision, chart: input.chart.value,
  } : undefined;
  const chartSimPayload = input.chartSim ? {
    schema: "deep-engine.chart-sim-runtime", schemaVersion: 1,
    id: input.chartSim.id, revision: input.chartSim.revision, fixture: input.chartSim.value,
  } : undefined;
  if (chartPayload) add(chartPayload.id, chartPayload.revision, "chart-runtime", chartPayload);
  if (chartSimPayload) add(chartSimPayload.id, chartSimPayload.revision, "chart-sim-runtime", chartSimPayload);
  const dynamicRuntimePayload = input.dynamicRuntime ? snapshotJson(input.dynamicRuntime.value) : undefined;
  if (input.dynamicRuntime) add(input.dynamicRuntime.id, input.dynamicRuntime.revision, "dynamic-runtime", dynamicRuntimePayload);
  const shaderIds: string[] = [];
  for (const shader of input.shaderPackages ?? []) {
    add(shader.value.packageId, shader.revision, "shader-package", shader.value); shaderIds.push(shader.value.packageId);
  }
  resources.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const hasCamera = Object.hasOwn(input, "camera");
  requireValue(!hasCamera || input.camera !== undefined, "$.camera", "Camera payload is required when provided.");
  const hasChart = Object.hasOwn(input, "chart") || Object.hasOwn(input, "chartSim");
  const hasDynamicRuntime = Object.hasOwn(input, "dynamicRuntime");
  requireValue(!hasDynamicRuntime || input.dynamicRuntime !== undefined, "$.dynamicRuntime", "Dynamic runtime payload is required when provided.");
  requireValue(!hasChart || input.chart !== undefined || input.chartSim !== undefined, "$.chart", "Chart payload is required when provided.");
  requireValue(!hasChart || input.chart !== undefined, "$.chart", "Runtime package v4 requires a chart payload; chartSim is optional.");
  requireValue(!input.deep2d || !input.chart, "$.chart", "Chart and deep2d entrypoints are mutually exclusive.");
  requireValue(!input.chartSim || input.chart, "$.chartSim", "chartSim requires a chart payload.");
  // v4 时代 materialBindings 字段必填(可为空数组),与 Native 校验一致。
  const hasBindings = hasChart || hasCamera || hasDynamicRuntime || Object.hasOwn(input, "materialBindings");
  const bindings = hasBindings ? normalizeRuntimeMaterialBindings(Object.hasOwn(input, "materialBindings") ? input.materialBindings : [], hasChart || hasCamera || hasDynamicRuntime) : undefined;
  const core = {
    schema: DEEP_RUNTIME_PACKAGE_SCHEMA,
    schemaVersion: hasDynamicRuntime ? DEEP_RUNTIME_PACKAGE_DYNAMIC_VERSION : hasChart ? DEEP_RUNTIME_PACKAGE_CHART_VERSION : hasCamera ? DEEP_RUNTIME_PACKAGE_CAMERA_VERSION : hasBindings ? DEEP_RUNTIME_PACKAGE_SHADER_BINDINGS_VERSION : DEEP_RUNTIME_PACKAGE_SCHEMA_VERSION,
    packageId: input.packageId, packageVersion: input.packageVersion,
    entrypoints: { renderPacket: input.renderPacket.id, deep2d: input.deep2d?.id ?? null,
      environment: environment.id, shaderPackages: shaderIds.sort(),
      ...(hasCamera ? { camera: input.camera!.id } : {}),
      ...(hasChart ? { chart: input.chart!.id, chartSim: input.chartSim?.id ?? null } : {}),
      ...(hasDynamicRuntime ? { dynamicRuntime: input.dynamicRuntime!.id } : {}) },
    resources, payloads,
    ...(objectBindings?.length ? { objectBindings: snapshotJson(objectBindings) } : {}),
    ...(hasBindings ? { materialBindings: snapshotJson(bindings) } : {}),
  };
  return core;
}

/** Serializes the just-built, validated snapshot before it is exposed to callers. */
export function buildDeepRuntimePackageArtifact(input: BuildDeepRuntimePackageInput): {
  readonly runtimePackage: DeepRuntimePackage; readonly packageJson: string;
} {
  const runtimePackage = buildDeepRuntimePackage(input);
  const packageJson = orderedRuntimeJson(runtimePackage as unknown as RuntimeJson);
  requireValue(new TextEncoder().encode(packageJson).length <= DEEP_RUNTIME_PACKAGE_BUDGETS.inputBytes,
    "$", "Serialized package exceeds 256 MiB.");
  return { runtimePackage, packageJson };
}

/** Background compiler owns every input before yielding; public validation still rechecks external packages. */
export async function buildDeepRuntimePackageArtifactAsync(input: BuildDeepRuntimePackageInput,
  options: { readonly signal?: AbortSignal } = {}): Promise<{ readonly runtimePackage: DeepRuntimePackage; readonly packageJson: string }> {
  options.signal?.throwIfAborted();
  const draft = createOwnedRuntimePackageCore(input), resources: RuntimeResourceIndexEntry[] = [];
  const hashes = new Map<string, string>();
  for (const resource of draft.resources) {
    const value = await hashOwnedRuntimeJson(draft.payloads[resource.id]!, options.signal);
    hashes.set(resource.id, value);
    resources.push({ ...resource, contentHash: { algorithm: "sha256", value } });
  }
  const core = { ...draft, resources };
  const packageHash = await hashOwnedRuntimeJson(core as unknown as RuntimeJson, options.signal);
  options.signal?.throwIfAborted();
  const runtimePackage = validateOwnedBuiltRuntimePackage({ ...core,
    packageHash: { algorithm: "sha256", value: packageHash } }, { packageHash, resources: hashes });
  const packageJson = orderedRuntimeJson(runtimePackage as unknown as RuntimeJson);
  requireValue(new TextEncoder().encode(packageJson).length <= DEEP_RUNTIME_PACKAGE_BUDGETS.inputBytes,
    "$", "Serialized package exceeds 256 MiB.");
  options.signal?.throwIfAborted();
  return { runtimePackage, packageJson };
}
