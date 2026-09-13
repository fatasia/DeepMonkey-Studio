import { evaluateAssetCompatibility } from "./assetCompatibility.js";
import {
  DEEP_ASSET_PACKAGE_BUDGETS,
  type DeepAssetBlobDescriptor,
  type DeepAssetImportPlan,
  type DeepAssetImporterProvenance,
  type DeepAssetPackage,
  type DeepAssetPackageIssue,
  type DeepAssetPackageIssueCode,
  type DeepAssetPackageValidation,
  type DeepAssetResource,
  type DeepAssetResourceKind,
  type DeepAssetSourceProvenance,
} from "./assetPackage.js";

const HASH = /^[a-f0-9]{64}$/;
const ID = /^[a-z0-9][a-z0-9._:/-]{0,255}$/;
const VERSION = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,127}$/;
const MEDIA_TYPE = /^[a-z0-9][a-z0-9.+-]{0,63}\/[a-z0-9][a-z0-9.+-]{0,127}$/;
const RESOURCE_KINDS: readonly DeepAssetResourceKind[] = [
  "scene", "mesh", "material", "texture", "animation", "skin", "morph",
  "metadata", "pmi", "behavior", "audio", "other",
];
const RESERVED = new Set(["__proto__", "prototype", "constructor"]);

function add(issues: DeepAssetPackageIssue[], code: DeepAssetPackageIssueCode, path: string, message: string): void {
  if (issues.length >= DEEP_ASSET_PACKAGE_BUDGETS.maxIssues) return;
  if (issues.length === DEEP_ASSET_PACKAGE_BUDGETS.maxIssues - 1) {
    issues.push({ code: "budget-exceeded", path: "$", message: "Diagnostic budget exceeded; remaining issues omitted." });
    return;
  }
  issues.push({ code, path, message });
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
function keys(value: Record<string, unknown>, allowed: readonly string[], path: string, issues: DeepAssetPackageIssue[]): void {
  const set = new Set(allowed);
  for (const key of Object.keys(value)) if (!set.has(key)) add(issues, "unknown-field", `${path}.${key}`, "Unknown Deep Asset Package v1 field.");
}
function stableId(value: unknown, path: string, issues: DeepAssetPackageIssue[]): value is string {
  if (typeof value === "string" && ID.test(value) && safeSegments(value)) return true;
  add(issues, "invalid-value", path, "Expected a canonical lowercase stable id."); return false;
}
function logicalPath(value: unknown, path: string, issues: DeepAssetPackageIssue[]): value is string {
  if (typeof value === "string" && value.length <= 512 && safeLogicalPath(value)) return true;
  add(issues, "invalid-value", path, "Expected a canonical relative logical path without traversal."); return false;
}
function safeSegments(value: string): boolean {
  return !value.includes("\\") && !value.startsWith("/") && !/^[A-Za-z]:/.test(value)
    && value.split("/").every((part) => part.length > 0 && part !== "." && part !== ".." && !RESERVED.has(part));
}
function safeLogicalPath(value: string): boolean {
  if (!value || value !== value.normalize("NFC") || /[\\\u0000-\u001f:*?"<>|]/.test(value) || value.startsWith("/")) return false;
  return value.split("/").every((part) => part.length > 0 && part !== "." && part !== ".."
    && !RESERVED.has(part.toLowerCase()) && !/[. ]$/.test(part) && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(part));
}
function hash(value: unknown, path: string, issues: DeepAssetPackageIssue[]): value is string {
  if (typeof value === "string" && HASH.test(value)) return true;
  add(issues, "invalid-value", path, "Expected lowercase SHA-256."); return false;
}
function nonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function sortedUnique(values: readonly string[]): boolean {
  return values.every((value, index) => index === 0 || values[index - 1]! < value);
}

export function validateDeepAssetPackage(input: unknown): DeepAssetPackageValidation {
  const issues: DeepAssetPackageIssue[] = [];
  deterministicJson(input, "$", issues, new WeakSet(), 0, { nodes: 0, aborted: false });
  if (issues.length || !record(input)) {
    if (!record(input)) add(issues, "invalid-type", "$", "Package must be a plain object.");
    return { valid: false, issues, resourceOrder: [] };
  }
  keys(input, ["schemaVersion", "manifest", "blobs"], "$", issues);
  if (input.schemaVersion !== 1) add(issues, "invalid-value", "$.schemaVersion", "Expected schema version 1.");
  const blobs = validateBlobs(input.blobs, issues);
  const resources = validateManifest(input.manifest, blobs, issues);
  const order = resources ? dependencyOrder([...resources.values()], issues) : [];
  const valid = issues.length === 0;
  return { valid, issues, resourceOrder: order, ...(valid ? { value: input as unknown as DeepAssetPackage } : {}) };
}

function validateBlobs(value: unknown, issues: DeepAssetPackageIssue[]): Map<string, DeepAssetBlobDescriptor> {
  const result = new Map<string, DeepAssetBlobDescriptor>();
  if (!Array.isArray(value)) { add(issues, "invalid-type", "$.blobs", "Expected blob descriptor array."); return result; }
  if (value.length > DEEP_ASSET_PACKAGE_BUDGETS.maxBlobs) add(issues, "budget-exceeded", "$.blobs", "Too many blobs.");
  for (const [index, candidate] of value.entries()) {
    const path = `$.blobs[${index}]`;
    if (!record(candidate)) { add(issues, "invalid-type", path, "Expected blob descriptor."); continue; }
    keys(candidate, ["hash", "byteLength", "mediaType"], path, issues);
    const validHash = hash(candidate.hash, `${path}.hash`, issues);
    if (!nonNegativeInteger(candidate.byteLength)) add(issues, "invalid-value", `${path}.byteLength`, "Expected non-negative safe integer.");
    if (typeof candidate.mediaType !== "string" || !MEDIA_TYPE.test(candidate.mediaType)) add(issues, "invalid-value", `${path}.mediaType`, "Expected normalized media type.");
    if (!validHash) continue;
    const blob = candidate as unknown as DeepAssetBlobDescriptor, previous = result.get(blob.hash);
    if (previous) add(issues, "duplicate-hash-conflict", `${path}.hash`, previous.byteLength === blob.byteLength && previous.mediaType === blob.mediaType
      ? "Blob hash must be declared once." : "Same hash declares conflicting blob metadata.");
    else result.set(blob.hash, blob);
  }
  if (!sortedUnique([...result.keys()])) add(issues, "non-deterministic", "$.blobs", "Blobs must be strictly sorted by hash.");
  return result;
}

function validateManifest(value: unknown, blobs: ReadonlyMap<string, DeepAssetBlobDescriptor>, issues: DeepAssetPackageIssue[]): Map<string, DeepAssetResource> | undefined {
  if (!record(value)) { add(issues, "invalid-type", "$.manifest", "Expected manifest object."); return undefined; }
  keys(value, ["schemaVersion", "packageId", "source", "importer", "compatibility", "resources", "entryScene"], "$.manifest", issues);
  if (value.schemaVersion !== 1) add(issues, "invalid-value", "$.manifest.schemaVersion", "Expected manifest schema version 1.");
  stableId(value.packageId, "$.manifest.packageId", issues);
  const source = validateSource(value.source, issues), importer = validateImporter(value.importer, issues);
  const compatibility = evaluateAssetCompatibility(value.compatibility, { target: "native-studio", requiredFacets: [], requireDeterministicOutput: true });
  compatibility.issues.forEach((message) => add(issues, "compatibility-mismatch", "$.manifest.compatibility", message));
  if (!compatibility.eligible) add(issues, "compatibility-mismatch", "$.manifest.compatibility", "Profile must be deterministic and eligible for a Deep native artifact.");
  validateFacetEvidenceOrder(value.compatibility, issues);
  if (record(value.compatibility) && source && value.compatibility.sourceKind !== source.kind) add(issues, "compatibility-mismatch", "$.manifest.source.kind", "Source kind differs from compatibility profile.");
  if (record(value.compatibility) && importer && (value.compatibility.importer !== importer.kind || value.compatibility.importerVersion !== importer.version)) {
    add(issues, "compatibility-mismatch", "$.manifest.importer", "Importer provenance differs from compatibility profile.");
  }
  const resources = validateResources(value.resources, blobs, issues);
  if (!stableId(value.entryScene, "$.manifest.entryScene", issues) || resources.get(value.entryScene)?.kind !== "scene") {
    add(issues, "invalid-entry-scene", "$.manifest.entryScene", "Entry scene must reference a declared scene resource.");
  }
  return resources;
}

function validateFacetEvidenceOrder(value: unknown, issues: DeepAssetPackageIssue[]): void {
  if (!record(value) || !record(value.facets)) return;
  for (const [facet, evidence] of Object.entries(value.facets)) {
    if (!record(evidence) || !Array.isArray(evidence.evidenceIds)) continue;
    if (!sortedUnique(evidence.evidenceIds as string[])) {
      add(issues, "non-deterministic", `$.manifest.compatibility.facets.${facet}.evidenceIds`, "Evidence ids must be sorted and unique.");
    }
  }
}

function validateSource(value: unknown, issues: DeepAssetPackageIssue[]): DeepAssetSourceProvenance | undefined {
  if (!record(value)) { add(issues, "invalid-type", "$.manifest.source", "Expected source provenance."); return undefined; }
  keys(value, ["kind", "logicalName", "contentHash", "byteLength"], "$.manifest.source", issues);
  logicalPath(value.logicalName, "$.manifest.source.logicalName", issues); hash(value.contentHash, "$.manifest.source.contentHash", issues);
  if (!nonNegativeInteger(value.byteLength)) add(issues, "invalid-value", "$.manifest.source.byteLength", "Expected non-negative safe integer.");
  return value as unknown as DeepAssetSourceProvenance;
}
function validateImporter(value: unknown, issues: DeepAssetPackageIssue[]): DeepAssetImporterProvenance | undefined {
  if (!record(value)) { add(issues, "invalid-type", "$.manifest.importer", "Expected importer provenance."); return undefined; }
  keys(value, ["kind", "id", "version", "recipeHash", "deterministic"], "$.manifest.importer", issues);
  stableId(value.id, "$.manifest.importer.id", issues);
  if (typeof value.version !== "string" || !VERSION.test(value.version)) add(issues, "invalid-value", "$.manifest.importer.version", "Expected bounded importer version.");
  hash(value.recipeHash, "$.manifest.importer.recipeHash", issues);
  if (value.deterministic !== true) add(issues, "non-deterministic", "$.manifest.importer.deterministic", "Importer output must be deterministic.");
  return value as unknown as DeepAssetImporterProvenance;
}

function validateResources(value: unknown, blobs: ReadonlyMap<string, DeepAssetBlobDescriptor>, issues: DeepAssetPackageIssue[]): Map<string, DeepAssetResource> {
  const result = new Map<string, DeepAssetResource>(), paths = new Set<string>();
  if (!Array.isArray(value)) { add(issues, "invalid-type", "$.manifest.resources", "Expected resource array."); return result; }
  if (value.length > DEEP_ASSET_PACKAGE_BUDGETS.maxResources) add(issues, "budget-exceeded", "$.manifest.resources", "Too many resources.");
  for (const [index, candidate] of value.entries()) {
    const path = `$.manifest.resources[${index}]`;
    if (!record(candidate)) { add(issues, "invalid-type", path, "Expected resource object."); continue; }
    keys(candidate, ["id", "kind", "logicalPath", "blobHash", "dependencies"], path, issues);
    const validId = stableId(candidate.id, `${path}.id`, issues);
    if (!RESOURCE_KINDS.includes(candidate.kind as DeepAssetResourceKind)) add(issues, "invalid-value", `${path}.kind`, "Unknown resource kind.");
    const validPath = logicalPath(candidate.logicalPath, `${path}.logicalPath`, issues);
    const validHash = hash(candidate.blobHash, `${path}.blobHash`, issues);
    if (validHash && !blobs.has(candidate.blobHash as string)) add(issues, "missing-blob", `${path}.blobHash`, "Resource blob is not declared.");
    let dependencies: string[] = [];
    if (!Array.isArray(candidate.dependencies)) add(issues, "invalid-type", `${path}.dependencies`, "Expected dependency id array.");
    else {
      if (candidate.dependencies.length > DEEP_ASSET_PACKAGE_BUDGETS.maxDependenciesPerResource) add(issues, "budget-exceeded", `${path}.dependencies`, "Too many dependencies.");
      dependencies = candidate.dependencies.flatMap((dependency, dependencyIndex) =>
        stableId(dependency, `${path}.dependencies[${dependencyIndex}]`, issues) ? [dependency] : []);
      if (dependencies.length === candidate.dependencies.length && !sortedUnique(dependencies)) {
        add(issues, "non-deterministic", `${path}.dependencies`, "Dependencies must be sorted and unique.");
      }
    }
    if (!validId) continue;
    if (validPath && paths.has(candidate.logicalPath as string)) add(issues, "duplicate-path", `${path}.logicalPath`, "Logical path must be unique.");
    else if (validPath) paths.add(candidate.logicalPath as string);
    if (result.has(candidate.id as string)) add(issues, "duplicate-id", `${path}.id`, "Resource id must be unique.");
    else result.set(candidate.id as string, { ...candidate, dependencies } as unknown as DeepAssetResource);
  }
  if (!sortedUnique([...result.keys()])) add(issues, "non-deterministic", "$.manifest.resources", "Resources must be strictly sorted by id.");
  for (const resource of result.values()) for (const dependency of resource.dependencies ?? []) {
    if (!result.has(dependency)) add(issues, "missing-dependency", `$.manifest.resources.${resource.id}.dependencies`, `Missing resource ${dependency}.`);
  }
  return result;
}

function dependencyOrder(resources: readonly DeepAssetResource[], issues: DeepAssetPackageIssue[]): string[] {
  const byId = new Map(resources.map((resource) => [resource.id, resource])), visiting = new Set<string>(), visited = new Set<string>(), order: string[] = [];
  const visit = (id: string) => {
    if (visited.has(id)) return;
    if (visiting.has(id)) { add(issues, "dependency-cycle", "$.manifest.resources", `Dependency cycle includes ${id}.`); return; }
    visiting.add(id);
    for (const dependency of byId.get(id)?.dependencies ?? []) if (byId.has(dependency)) visit(dependency);
    visiting.delete(id); visited.add(id); order.push(id);
  };
  [...byId.keys()].sort().forEach(visit);
  return order;
}

export function planDeepAssetImport(input: unknown, snapshot: unknown): DeepAssetImportPlan {
  const validation = validateDeepAssetPackage(input), snapshotIssues = validateSnapshot(snapshot), issues = [...validation.issues, ...snapshotIssues];
  if (issues.length || !validation.value || !record(snapshot)) return { status: "rejected", issues, commit: null };
  const current = new Set(snapshot.blobHashes as string[]), hashes = validation.value.blobs.map((blob) => blob.hash);
  const manifest = validation.value.manifest;
  return { status: "ready", issues: [], commit: {
    expectedRevision: snapshot.revision as number, nextRevision: (snapshot.revision as number) + 1,
    nextActive: { packageId: manifest.packageId, sourceHash: manifest.source.contentHash, recipeHash: manifest.importer.recipeHash },
    entryScene: manifest.entryScene, resourceOrder: validation.resourceOrder,
    addBlobHashes: hashes.filter((item) => !current.has(item)), reuseBlobHashes: hashes.filter((item) => current.has(item)),
  } };
}

function validateSnapshot(value: unknown): DeepAssetPackageIssue[] {
  const issues: DeepAssetPackageIssue[] = [];
  deterministicJson(value, "$snapshot", issues, new WeakSet(), 0, { nodes: 0, aborted: false });
  if (!record(value)) { add(issues, "invalid-type", "$snapshot", "Snapshot must be a plain object."); return issues; }
  keys(value, ["revision", "active", "blobHashes"], "$snapshot", issues);
  if (!nonNegativeInteger(value.revision) || value.revision === Number.MAX_SAFE_INTEGER) {
    add(issues, "invalid-value", "$snapshot.revision", "Expected a non-negative revision with room for the next commit.");
  }
  if (!Array.isArray(value.blobHashes) || value.blobHashes.some((item, index) => !hash(item, `$snapshot.blobHashes[${index}]`, issues))) add(issues, "invalid-type", "$snapshot.blobHashes", "Expected blob hash array.");
  else if (!sortedUnique(value.blobHashes as string[])) add(issues, "non-deterministic", "$snapshot.blobHashes", "Blob hashes must be sorted and unique.");
  if (value.active !== null) {
    if (!record(value.active)) add(issues, "invalid-type", "$snapshot.active", "Expected active revision or null.");
    else {
      keys(value.active, ["packageId", "sourceHash", "recipeHash"], "$snapshot.active", issues);
      stableId(value.active.packageId, "$snapshot.active.packageId", issues);
      hash(value.active.sourceHash, "$snapshot.active.sourceHash", issues);
      hash(value.active.recipeHash, "$snapshot.active.recipeHash", issues);
    }
  }
  return issues;
}

function deterministicJson(value: unknown, path: string, issues: DeepAssetPackageIssue[], seen: WeakSet<object>, depth: number, state: { nodes: number; aborted: boolean }): void {
  if (state.aborted) return;
  state.nodes += 1;
  if (state.nodes > DEEP_ASSET_PACKAGE_BUDGETS.maxJsonNodes) {
    add(issues, "budget-exceeded", path, "JSON node budget exceeded."); state.aborted = true; return;
  }
  if (depth > DEEP_ASSET_PACKAGE_BUDGETS.maxJsonDepth) { add(issues, "budget-exceeded", path, "JSON depth budget exceeded."); return; }
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "string") { if (value.length > DEEP_ASSET_PACKAGE_BUDGETS.maxStringLength) add(issues, "budget-exceeded", path, "String budget exceeded."); return; }
  if (typeof value === "number") { if (!Number.isFinite(value) || Object.is(value, -0)) add(issues, "non-deterministic", path, "Numbers must be finite and canonical."); return; }
  if (typeof value !== "object") { add(issues, "non-deterministic", path, "Only deterministic JSON values are allowed."); return; }
  if (seen.has(value)) { add(issues, "non-deterministic", path, "Shared or cyclic object graph is not canonical JSON."); return; }
  seen.add(value);
  const descriptors = Object.getOwnPropertyDescriptors(value), symbols = Object.getOwnPropertySymbols(value);
  if (symbols.length || Object.values(descriptors).some((item) => item.get || item.set)) add(issues, "non-deterministic", path, "Symbols and accessors are forbidden.");
  if (Array.isArray(value)) {
    const ownKeys = Object.keys(value);
    if (Object.getPrototypeOf(value) !== Array.prototype || ownKeys.length !== value.length || ownKeys.some((key, index) => key !== String(index))) {
      add(issues, "non-deterministic", path, "Arrays must be dense and ordinary.");
    }
    for (let index = 0; index < value.length && !state.aborted; index += 1) {
      deterministicJson(descriptors[String(index)]?.value, `${path}[${index}]`, issues, seen, depth + 1, state);
    }
  } else if (record(value)) {
    for (const key of Object.keys(value)) {
      deterministicJson(descriptors[key]?.value, `${path}.${key}`, issues, seen, depth + 1, state);
      if (state.aborted) break;
    }
  } else add(issues, "non-deterministic", path, "Objects must use Object or null prototype.");
}
