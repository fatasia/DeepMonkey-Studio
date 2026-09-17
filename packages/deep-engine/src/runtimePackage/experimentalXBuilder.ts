import { buildDeepRuntimePackage } from "./builder.js";
import { orderedRuntimeJson, runtimePackageSha256 } from "./hash.js";
import { fields, record, requireValue, snapshotJson } from "./primitives.js";
import { freezeExperimentalXResource } from "./experimentalXFreeze.js";
import type { BuildExperimentalXRuntimeInput, ExperimentalXRuntimePackage } from "./experimentalXTypes.js";
import type { RuntimeJson } from "./types.js";

function dataRecord(value: unknown, path: string): Record<string, unknown> {
  const result = record(value, path);
  requireValue(Object.getOwnPropertySymbols(result).length === 0
    && Object.values(Object.getOwnPropertyDescriptors(result)).every(item => "value" in item && item.enumerable), path, "Accessors and hidden fields are not author content.");
  return result;
}

export function buildExperimentalXRuntimePackage(input: BuildExperimentalXRuntimeInput): {
  runtimePackage: ExperimentalXRuntimePackage; packageJson: string;
} {
  const raw = dataRecord(input, "$input");
  fields(raw, ["packageId", "packageVersion", "renderPacket", "experimentalX"],
    ["environment", "deep2d", "shaderPackages", "materialBindings"], "$input");
  const x = dataRecord(input.experimentalX, "$input.experimentalX");
  fields(x, ["id", "revision", "request"], [], "$input.experimentalX");
  const frozen = freezeExperimentalXResource(input.experimentalX.id, input.experimentalX.revision, input.experimentalX.request);
  const { experimentalX: _x, materialBindings, ...staticInput } = input;
  requireValue(!Object.hasOwn(input, "materialBindings") || Array.isArray(materialBindings), "$.materialBindings", "Expected material bindings array.");
  const base = buildDeepRuntimePackage({ ...staticInput,
    ...(materialBindings?.length ? { materialBindings } : {}) });
  requireValue(!Object.hasOwn(base.payloads, frozen.index.id), "$.experimentalX.id", "Duplicate resource id.");
  requireValue(base.resources.length < 132, "$.resources", "Resource index budget exceeded.");
  const core = { ...base, schemaVersion: 6 as const,
    entrypoints: { ...base.entrypoints, experimentalX: frozen.index.id },
    materialBindings: base.schemaVersion === 2 ? base.materialBindings : [],
    resources: [...base.resources, frozen.index].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    payloads: { ...base.payloads, [frozen.index.id]: snapshotJson(frozen.payload) } };
  const runtimePackage = { ...core, packageHash: { algorithm: "sha256" as const, value: runtimePackageSha256(core) } } as ExperimentalXRuntimePackage;
  const packageJson = orderedRuntimeJson(snapshotJson(runtimePackage) as RuntimeJson);
  requireValue(new TextEncoder().encode(packageJson).length <= 256 * 1024 * 1024, "$", "Package byte budget exceeded.");
  return { runtimePackage, packageJson };
}
