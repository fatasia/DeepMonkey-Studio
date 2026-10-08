import type { OntologyActionPlanInput, OntologyActionType, OntologyPackage } from "@bim-studio/contracts";

export class OntologyActionInputError extends Error {
  constructor(readonly code: "identity-invalid" | "identity-unregistered" | "object-unbound" | "json-invalid" | "parameters-not-object") { super(code); }
}

export function ontologyActionTargetIds(pkg: OntologyPackage, action: OntologyActionType): string[] {
  const object = pkg.objects.find(item => item.key === action.boundObject);
  // Object mappings define the server's identity allowlist; package mappings supplement unmapped objects.
  const mappings = object?.identityMappings.length ? object.identityMappings : pkg.identityMappings;
  return [...new Set(mappings.filter(item => item.objectKey === action.boundObject && item.canonicalId.trim()).map(item => item.canonicalId))];
}

export function ontologyActionDefaultArguments(action: OntologyActionType): string {
  const value = action.inputSchema.default;
  return JSON.stringify(value && typeof value === "object" && !Array.isArray(value) ? value : {}, null, 2);
}

export function buildOntologyActionPreviewInput(pkg: OntologyPackage, action: OntologyActionType, canonicalId: string, parameters: string): OntologyActionPlanInput {
  const identity = canonicalId.trim();
  if (!identity || identity.includes("..") || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/.test(identity)) throw new OntologyActionInputError("identity-invalid");
  const ids = ontologyActionTargetIds(pkg, action);
  if (ids.length && !ids.includes(identity)) throw new OntologyActionInputError("identity-unregistered");
  if (!pkg.objects.some(object => object.key === action.boundObject)) throw new OntologyActionInputError("object-unbound");
  let args: unknown;
  try { args = JSON.parse(parameters); } catch { throw new OntologyActionInputError("json-invalid"); }
  if (!args || typeof args !== "object" || Array.isArray(args)) throw new OntologyActionInputError("parameters-not-object");
  return { packageId: pkg.id, actionKey: action.key, target: { objectKey: action.boundObject, canonicalId: identity }, arguments: args as Record<string, unknown> };
}
