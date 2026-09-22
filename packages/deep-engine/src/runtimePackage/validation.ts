import { validateDeepShaderPackage } from "../shaderPackage/validation.js";
import type { DeepShaderPackageV2 } from "../shaderPackage/types.js";
import { validateRuntimeMaterialBindings } from "./materialBindings.js";
import { validateRuntimeDeep2d } from "./deep2d.js";
import { validateDashboardComposition } from "./dashboardCompositionValidation.js";
import { DEEP_RUNTIME_PACKAGE_DASHBOARD_VERSION } from "./dashboardCompositionTypes.js";
import { validateRuntimeChartPackage, validateRuntimeChartSimPackage } from "./chartPackage.js";
import { validateRuntimeSceneCamera } from "./camera.js";
import { validateDynamicSceneRuntime } from "./dynamicSceneRuntime.js";
import { runtimeContentSha256, runtimePackageSha256 } from "./hash.js";
import { array, fields, record, requireValue, resourceId, revision, RuntimePackageError, snapshotJson, string } from "./primitives.js";
import { validateRuntimeRenderPacket } from "./renderPacket.js";
import { BUILTIN_RUNTIME_IBL_ID, validateRuntimeEnvironment } from "./environment.js";
import { DEEP_RUNTIME_PACKAGE_BUDGETS as LIMITS, DEEP_RUNTIME_PACKAGE_SCHEMA, DEEP_RUNTIME_PACKAGE_SCHEMA_VERSION,
  DEEP_RUNTIME_PACKAGE_SHADER_BINDINGS_VERSION, DEEP_RUNTIME_PACKAGE_CHART_VERSION, DEEP_RUNTIME_PACKAGE_DYNAMIC_VERSION, type DeepRuntimePackage, type RuntimePackageValidation, type RuntimeResourceKind } from "./types.js";

export { BUILTIN_RUNTIME_IBL_ID } from "./environment.js";
function hash(value: unknown, path: string): string {
  const object = record(value, path);
  fields(object, ["algorithm", "value"], [], path);
  requireValue(object.algorithm === "sha256" && typeof object.value === "string" && /^[a-f0-9]{64}$/.test(object.value), path, "Expected lowercase SHA-256.");
  return object.value;
}
function validate(input: unknown): DeepRuntimePackage {
  const value = record(snapshotJson(input), "$");
  const entrypointShape = record(value.entrypoints, "$.entrypoints");
  const hasDynamicRuntime = value.schemaVersion === DEEP_RUNTIME_PACKAGE_DYNAMIC_VERSION;
  const hasCamera = value.schemaVersion === 3 || hasDynamicRuntime && Object.hasOwn(entrypointShape, "camera");
  const hasChart = value.schemaVersion === DEEP_RUNTIME_PACKAGE_CHART_VERSION || hasDynamicRuntime && Object.hasOwn(entrypointShape, "chart");
  const hasDashboard = value.schemaVersion === DEEP_RUNTIME_PACKAGE_DASHBOARD_VERSION;
  const hasBindings = hasCamera || hasChart || hasDashboard || hasDynamicRuntime || value.schemaVersion === DEEP_RUNTIME_PACKAGE_SHADER_BINDINGS_VERSION;
  fields(value, ["schema", "schemaVersion", "packageId", "packageVersion", "entrypoints", "resources", "payloads", "packageHash",
    ...(hasBindings ? ["materialBindings"] : [])], [], "$");
  requireValue(value.schema === DEEP_RUNTIME_PACKAGE_SCHEMA && (value.schemaVersion === DEEP_RUNTIME_PACKAGE_SCHEMA_VERSION || hasBindings),
    "$", "Unsupported runtime package schema or version.");
  const packageId = resourceId(value.packageId, "$.packageId");
  requireValue(packageId.length <= 128 && !/[/:]/.test(packageId), "$.packageId", "Invalid package identifier.");
  const version = string(value.packageVersion, "$.packageVersion");
  requireValue(/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(version), "$.packageVersion", "Invalid package version.");
  requireValue(hash(value.packageHash, "$.packageHash") === runtimePackageSha256(value), "$.packageHash", "Package hash mismatch.");
  const entries = array(value.resources, "$.resources", LIMITS.resources);
  requireValue(entries.length >= 2, "$.resources", "Runtime package requires at least two resources.");
  const index = new Map<string, { kind: RuntimeResourceKind; revision: number; hash: string }>();
  let previous = "";
  for (const [position, candidate] of entries.entries()) {
    const path = `$.resources[${position}]`, entry = record(candidate, path);
    fields(entry, ["id", "kind", "revision", "contentHash"], [], path);
    const id = resourceId(entry.id, `${path}.id`);
    requireValue(id > previous, path, "Resource index must be sorted by unique id."); previous = id;
    requireValue(["render-packet", "deep2d-runtime", "ibl-environment", "shader-package", ...(hasCamera ? ["scene-camera"] : []),
      ...(hasChart || hasDashboard ? ["chart-runtime", "chart-sim-runtime"] : []),
      ...(hasDashboard ? ["dashboard-runtime"] : []), ...(hasDynamicRuntime ? ["dynamic-runtime"] : [])].includes(string(entry.kind, `${path}.kind`)), path, "Unknown resource kind.");
    index.set(id, { kind: entry.kind as RuntimeResourceKind, revision: revision(entry.revision, `${path}.revision`), hash: hash(entry.contentHash, `${path}.contentHash`) });
  }
  const payloads = record(value.payloads, "$.payloads");
  requireValue(Object.keys(payloads).length === index.size && Object.keys(payloads).every(id => index.has(id)), "$.payloads", "Payload keys must exactly match the resource index.");
  for (const [id, entry] of index) requireValue(runtimeContentSha256(payloads[id]) === entry.hash, `$.payloads.${id}`, "Resource content hash mismatch.");
  const entry = entrypointShape;
  fields(entry, ["renderPacket", "deep2d", "environment", "shaderPackages", ...(hasCamera ? ["camera"] : []),
    ...(hasChart || hasDashboard ? ["chart", "chartSim"] : []), ...(hasDashboard ? ["dashboard"] : []), ...(hasDynamicRuntime ? ["dynamicRuntime"] : [])], [], "$.entrypoints");
  if (hasDashboard) requireValue(entry.deep2d === null && entry.chart === null && entry.chartSim === null,
    "$.entrypoints", "Dashboard owns all 2D content references.");
  const used = new Set<string>();
  const use = (value: unknown, kind: RuntimeResourceKind): string => {
    const id = resourceId(value, `$.entrypoints.${kind}`);
    requireValue(index.get(id)?.kind === kind && !used.has(id), "$.entrypoints", "Entrypoint missing, repeated, or wrong kind.");
    used.add(id); return id;
  };
  const renderId = use(entry.renderPacket, "render-packet"), environmentId = use(entry.environment, "ibl-environment");
  const deep2dId = entry.deep2d === null ? null : use(entry.deep2d, "deep2d-runtime");
  const cameraId = hasCamera ? use(entry.camera, "scene-camera") : null;
  // v4:chart 键必填且非空,chartSim 键必填可空;chart 与 deep2d 互斥。
  const chartId = hasChart ? use(entry.chart, "chart-runtime") : null;
  const chartSimId = hasChart && entry.chartSim !== null ? use(entry.chartSim, "chart-sim-runtime") : null;
  const dynamicRuntimeId = hasDynamicRuntime ? use(entry.dynamicRuntime, "dynamic-runtime") : null;
  requireValue(chartId === null || deep2dId === null, "$.entrypoints", "Chart and deep2d entrypoints are mutually exclusive.");
  requireValue(chartSimId === null || chartId !== null, "$.entrypoints", "chartSim requires a chart entrypoint.");
  const shaderIds = array(entry.shaderPackages, "$.entrypoints.shaderPackages", LIMITS.shaderPackages).map(value => use(value, "shader-package"));
  requireValue(shaderIds.every((id, i) => i === 0 || id > shaderIds[i - 1]!), "$.entrypoints.shaderPackages", "Shader entrypoints must be sorted and unique.");
  if (hasDashboard) {
    const dashboardId = use(entry.dashboard, "dashboard-runtime");
    validateDashboardComposition(payloads[dashboardId], dashboardId, index, payloads, use);
    const packet = record(payloads[renderId], `$.payloads.${renderId}`);
    requireValue(["geometries", "materials", "instances", "textures"].every(key => Array.isArray(packet[key]) && packet[key].length === 0)
      && shaderIds.length === 0 && array(value.materialBindings, "$.materialBindings").length === 0,
    "$.entrypoints", "Dashboard requires an empty render packet and no shader bindings.");
    const environment = record(payloads[environmentId], `$.payloads.${environmentId}`);
    requireValue(environmentId === BUILTIN_RUNTIME_IBL_ID && environment.schema === "deep-engine.ibl-reference"
      && environment.kind === "builtin-default", "$.entrypoints.environment", "Dashboard requires the builtin environment.");
  }
  requireValue(used.size === index.size, "$.entrypoints", "Every resource needs exactly one entrypoint role.");
  validateRuntimeRenderPacket(payloads[renderId], `$.payloads.${renderId}`);
  if (cameraId !== null) {
    const camera = validateRuntimeSceneCamera(payloads[cameraId]);
    requireValue(camera.id === cameraId && camera.revision === index.get(cameraId)!.revision,
      `$.payloads.${cameraId}`, "Camera identity differs from index.");
  }
  validateRuntimeEnvironment(payloads[environmentId], environmentId, index.get(environmentId)!.revision, `$.payloads.${environmentId}`);
  if (deep2dId !== null) validateRuntimeDeep2d(payloads[deep2dId], deep2dId, index.get(deep2dId)!.revision, `$.payloads.${deep2dId}`);
  let chartIr: unknown;
  if (chartId !== null) chartIr = validateRuntimeChartPackage(payloads[chartId], chartId, index.get(chartId)!.revision, `$.payloads.${chartId}`);
  if (chartSimId !== null) validateRuntimeChartSimPackage(payloads[chartSimId], chartSimId, index.get(chartSimId)!.revision, chartIr, `$.payloads.${chartSimId}`);
  if (dynamicRuntimeId !== null) {
    const dynamic = validateDynamicSceneRuntime(payloads[dynamicRuntimeId]);
    requireValue(dynamic.valid, `$.payloads.${dynamicRuntimeId}`, dynamic.issues[0]?.message ?? "Invalid dynamic runtime.");
    requireValue(dynamic.value.id === dynamicRuntimeId && dynamic.value.revision === index.get(dynamicRuntimeId)!.revision,
      `$.payloads.${dynamicRuntimeId}`, "Dynamic runtime identity differs from index.");
  }
  const shaders = new Map<string, DeepShaderPackageV2>();
  for (const shaderId of shaderIds) {
    const shader = validateDeepShaderPackage(payloads[shaderId]);
    requireValue(shader.valid, `$.payloads.${shaderId}`, shader.diagnostics[0]?.message ?? "Invalid shader package.");
    requireValue(shader.value?.packageId === shaderId, `$.payloads.${shaderId}`, "Shader identity differs from index.");
    shaders.set(shaderId, shader.value);
  }
  if (hasBindings) {
    const packet = payloads[renderId] as { materials: readonly { id: string }[] };
    validateRuntimeMaterialBindings(value.materialBindings, packet.materials, shaders, hasCamera || hasChart || hasDashboard || hasDynamicRuntime);
  }
  return value as unknown as DeepRuntimePackage;
}
export function validateDeepRuntimePackage(input: unknown): RuntimePackageValidation {
  try { return { valid: true, value: validate(input), issues: [] }; }
  catch (error) {
    return { valid: false, issues: [{ path: error instanceof RuntimePackageError ? error.path : "$",
      message: error instanceof Error ? error.message : "Invalid runtime package." }] };
  }
}
