import { prepareRenderPacket } from "../renderPacket.js";
import { runtimeContentSha256, runtimePackageSha256 } from "./hash.js";
import { normalizeRuntimeMaterialBindings } from "./materialBindings.js";
import { record, requireValue, snapshotJson } from "./primitives.js";
import { normalizeRuntimeRenderPacket, validateRuntimeRenderPacket } from "./renderPacket.js";
import { BUILTIN_RUNTIME_IBL_ID, validateDeepRuntimePackage } from "./validation.js";
import { DEEP_RUNTIME_PACKAGE_SCHEMA, DEEP_RUNTIME_PACKAGE_SCHEMA_VERSION, DEEP_RUNTIME_PACKAGE_SHADER_BINDINGS_VERSION, DEEP_RUNTIME_PACKAGE_CAMERA_VERSION, DEEP_RUNTIME_PACKAGE_CHART_VERSION,
  type BuildDeepRuntimePackageInput, type DeepRuntimePackage, type RuntimeJson,
  type RuntimeResourceIndexEntry, type RuntimeResourceKind } from "./types.js";

export function buildDeepRuntimePackage(input: BuildDeepRuntimePackageInput): DeepRuntimePackage {
  const packet = record(snapshotJson(input.renderPacket.value, true), "$.renderPacket");
  validateRuntimeRenderPacket(packet, "$.renderPacket");
  prepareRenderPacket(input.renderPacket.value);
  normalizeRuntimeRenderPacket(packet);
  const payloads: Record<string, RuntimeJson> = Object.create(null), resources: RuntimeResourceIndexEntry[] = [];
  const add = (id: string, revision: number, kind: RuntimeResourceKind, value: unknown): void => {
    requireValue(!Object.hasOwn(payloads, id), "$.resources", `Duplicate resource id: ${id}.`);
    const payload = snapshotJson(value);
    payloads[id] = payload;
    resources.push({ id, revision, kind, contentHash: { algorithm: "sha256", value: runtimeContentSha256(payload) } });
  };
  add(input.renderPacket.id, input.renderPacket.revision, "render-packet", packet);
  const environment = {
    schema: "deep-engine.ibl-reference", schemaVersion: 1, id: BUILTIN_RUNTIME_IBL_ID, revision: 1, kind: "builtin-default",
  };
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
  const shaderIds: string[] = [];
  for (const shader of input.shaderPackages ?? []) {
    add(shader.value.packageId, shader.revision, "shader-package", shader.value); shaderIds.push(shader.value.packageId);
  }
  resources.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const hasCamera = Object.hasOwn(input, "camera");
  requireValue(!hasCamera || input.camera !== undefined, "$.camera", "Camera payload is required when provided.");
  const hasChart = Object.hasOwn(input, "chart") || Object.hasOwn(input, "chartSim");
  requireValue(!hasChart || input.chart !== undefined || input.chartSim !== undefined, "$.chart", "Chart payload is required when provided.");
  requireValue(!hasChart || input.chart !== undefined, "$.chart", "Runtime package v4 requires a chart payload; chartSim is optional.");
  requireValue(!input.deep2d || !input.chart, "$.chart", "Chart and deep2d entrypoints are mutually exclusive.");
  requireValue(!input.chartSim || input.chart, "$.chartSim", "chartSim requires a chart payload.");
  // v4 时代 materialBindings 字段必填(可为空数组),与 Native 校验一致。
  const hasBindings = hasChart || hasCamera || Object.hasOwn(input, "materialBindings");
  const bindings = hasBindings ? normalizeRuntimeMaterialBindings(Object.hasOwn(input, "materialBindings") ? input.materialBindings : [], hasChart || hasCamera) : undefined;
  const core = {
    schema: DEEP_RUNTIME_PACKAGE_SCHEMA,
    schemaVersion: hasChart ? DEEP_RUNTIME_PACKAGE_CHART_VERSION : hasCamera ? DEEP_RUNTIME_PACKAGE_CAMERA_VERSION : hasBindings ? DEEP_RUNTIME_PACKAGE_SHADER_BINDINGS_VERSION : DEEP_RUNTIME_PACKAGE_SCHEMA_VERSION,
    packageId: input.packageId, packageVersion: input.packageVersion,
    entrypoints: { renderPacket: input.renderPacket.id, deep2d: input.deep2d?.id ?? null,
      environment: environment.id, shaderPackages: shaderIds.sort(),
      ...(hasCamera ? { camera: input.camera!.id } : {}),
      ...(hasChart ? { chart: input.chart!.id, chartSim: input.chartSim?.id ?? null } : {}) },
    resources, payloads,
    ...(hasBindings ? { materialBindings: bindings } : {}),
  };
  const result = validateDeepRuntimePackage({ ...core, packageHash: { algorithm: "sha256", value: runtimePackageSha256(core) } });
  if (!result.valid) throw new Error(result.issues[0]?.message ?? "Invalid runtime package.");
  return result.value;
}
