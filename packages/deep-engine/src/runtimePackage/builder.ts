import { prepareRenderPacket } from "../renderPacket.js";
import { runtimeContentSha256, runtimePackageSha256 } from "./hash.js";
import { normalizeRuntimeMaterialBindings } from "./materialBindings.js";
import { record, requireValue, snapshotJson } from "./primitives.js";
import { normalizeRuntimeRenderPacket, validateRuntimeRenderPacket } from "./renderPacket.js";
import { BUILTIN_RUNTIME_IBL_ID, validateDeepRuntimePackage } from "./validation.js";
import { DEEP_RUNTIME_PACKAGE_SCHEMA, DEEP_RUNTIME_PACKAGE_SCHEMA_VERSION, DEEP_RUNTIME_PACKAGE_SHADER_BINDINGS_VERSION,
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
  add(BUILTIN_RUNTIME_IBL_ID, 1, "ibl-environment", {
    schema: "deep-engine.ibl-reference", schemaVersion: 1, id: BUILTIN_RUNTIME_IBL_ID, revision: 1, kind: "builtin-default",
  });
  if (input.deep2d) add(input.deep2d.id, input.deep2d.revision, "deep2d-runtime", input.deep2d);
  const shaderIds: string[] = [];
  for (const shader of input.shaderPackages ?? []) {
    add(shader.value.packageId, shader.revision, "shader-package", shader.value); shaderIds.push(shader.value.packageId);
  }
  resources.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const hasBindings = Object.hasOwn(input, "materialBindings");
  const bindings = hasBindings ? normalizeRuntimeMaterialBindings(input.materialBindings) : undefined;
  const core = {
    schema: DEEP_RUNTIME_PACKAGE_SCHEMA,
    schemaVersion: hasBindings ? DEEP_RUNTIME_PACKAGE_SHADER_BINDINGS_VERSION : DEEP_RUNTIME_PACKAGE_SCHEMA_VERSION,
    packageId: input.packageId, packageVersion: input.packageVersion,
    entrypoints: { renderPacket: input.renderPacket.id, deep2d: input.deep2d?.id ?? null,
      environment: BUILTIN_RUNTIME_IBL_ID, shaderPackages: shaderIds.sort() }, resources, payloads,
    ...(hasBindings ? { materialBindings: bindings } : {}),
  };
  const result = validateDeepRuntimePackage({ ...core, packageHash: { algorithm: "sha256", value: runtimePackageSha256(core) } });
  if (!result.valid) throw new Error(result.issues[0]?.message ?? "Invalid runtime package.");
  return result.value;
}
