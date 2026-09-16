import {
  DEEP_ASSET_PACKAGE_BUDGETS,
  type DeepAssetImportCommit, type DeepAssetPackage, type DeepAssetPackageIssue, type DeepAssetResource,
  type DeepAssetStoreSnapshot,
} from "./assetPackage.js";
import { planDeepAssetImport, validateDeepAssetPackage } from "./assetPackageValidation.js";

const HASH = /^[a-f0-9]{64}$/;
const ID = /^[a-z0-9][a-z0-9._:/-]{0,255}$/;

export type DeepAssetResourceChangeField = "kind" | "logicalPath" | "blobHash" | "dependencies";
export interface DeepAssetResourceUpdate {
  readonly id: string;
  readonly changes: readonly DeepAssetResourceChangeField[];
  readonly renamed: boolean;
}
export interface DeepAssetReimportDiff {
  readonly unchanged: readonly string[];
  readonly add: readonly string[];
  readonly update: readonly DeepAssetResourceUpdate[];
  readonly remove: readonly string[];
}

/** Opaque authored override tied to a stable resource GUID and the source blob it was based on. */
export interface DeepAssetUserOverride {
  readonly id: string;
  readonly resourceId: string;
  readonly baseBlobHash: string;
  readonly overrideHash: string;
  readonly revision: number;
}
export type DeepAssetOverrideConflictReason = "removed-resource" | "resource-kind-changed" | "source-changed" | "stale-base";
export interface DeepAssetOverrideConflict {
  readonly overrideId: string;
  readonly resourceId: string;
  readonly reason: DeepAssetOverrideConflictReason;
  readonly previousBlobHash: string | null;
  readonly nextBlobHash: string | null;
}

export interface DeepAssetReimportExecution {
  /** Changed resources, affected dependents, and their prerequisites; dependencies always precede users. */
  readonly stageOrder: readonly string[];
  /** Changed resources plus unchanged dependents that must refresh after a dependency changed. */
  readonly publishOrder: readonly string[];
  /** Obsolete dependents precede obsolete dependencies. Removal happens only in the atomic publication. */
  readonly removeOrder: readonly string[];
  /** Reverse staged-resource release order if preparation fails before publication. */
  readonly rollbackOrder: readonly string[];
}
export interface DeepAssetReimportVersionStamp {
  readonly generation: number;
  readonly expectedStoreRevision: number;
  readonly nextStoreRevision: number;
  readonly packageId: string;
  readonly baseSourceHash: string;
  readonly nextSourceHash: string;
  readonly baseRecipeHash: string;
  readonly nextRecipeHash: string;
}
export interface DeepAssetReimportIssue {
  readonly code: DeepAssetPackageIssue["code"] | "invalid-generation" | "invalid-override" | "package-mismatch" | "stale-base";
  readonly path: string;
  readonly message: string;
}
export interface DeepAssetReimportPlan {
  readonly status: "ready" | "conflicted" | "rejected";
  readonly issues: readonly DeepAssetReimportIssue[];
  readonly conflicts: readonly DeepAssetOverrideConflict[];
  readonly preservedOverrides: readonly DeepAssetUserOverride[];
  readonly diff: DeepAssetReimportDiff | null;
  readonly execution: DeepAssetReimportExecution | null;
  /** Existing store executor can stage this commit, then CAS both revision and generation. */
  readonly commit: DeepAssetImportCommit | null;
  readonly version: DeepAssetReimportVersionStamp | null;
}
export interface DeepAssetReimportOptions {
  /** Caller-owned monotonic token. The executor must publish only while this remains current. */
  readonly generation: number;
  readonly overrides?: readonly DeepAssetUserOverride[];
}

/** Creates a deterministic, side-effect-free reimport transaction plan keyed by stable resource id. */
export function planDeepAssetReimport(previousInput: unknown, nextInput: unknown,
  snapshotInput: unknown, options: DeepAssetReimportOptions): DeepAssetReimportPlan {
  const issues: DeepAssetReimportIssue[] = [];
  if (!options || typeof options !== "object" || !Number.isSafeInteger(options.generation) || options.generation < 1) {
    issues.push({ code: "invalid-generation", path: "$options.generation",
      message: "Reimport generation must be a positive safe integer." });
  }
  const overrides = validateOverrides(options?.overrides, issues);
  const previous = validateDeepAssetPackage(previousInput), next = validateDeepAssetPackage(nextInput);
  issues.push(...prefixIssues(previous.issues, "$previous"), ...prefixIssues(next.issues, "$next"));
  if (issues.length || !previous.value || !next.value) return rejected(issues);
  const importPlan = planDeepAssetImport(next.value, snapshotInput);
  if (importPlan.status !== "ready" || !importPlan.commit) {
    return rejected(importPlan.issues.map(issue => ({ ...issue })));
  }
  const prior = previous.value, candidate = next.value;
  if (prior.manifest.packageId !== candidate.manifest.packageId) {
    return rejected([{ code: "package-mismatch", path: "$next.manifest.packageId",
      message: "Incremental reimport must preserve the package id." }]);
  }
  const snapshot = snapshotInput as DeepAssetStoreSnapshot;
  if (!sameActive(snapshot.active, prior)) {
    return rejected([{ code: "stale-base", path: "$snapshot.active",
      message: "Store active revision does not match the previous package provenance." }]);
  }
  const diff = buildDiff(prior.manifest.resources, candidate.manifest.resources);
  const execution = buildExecution(prior.manifest.resources, candidate.manifest.resources,
    previous.resourceOrder, next.resourceOrder, diff);
  const { preserved, conflicts } = resolveOverrides(overrides, prior.manifest.resources, candidate.manifest.resources);
  const version = Object.freeze({ generation: options.generation,
    expectedStoreRevision: importPlan.commit.expectedRevision, nextStoreRevision: importPlan.commit.nextRevision,
    packageId: candidate.manifest.packageId, baseSourceHash: prior.manifest.source.contentHash,
    nextSourceHash: candidate.manifest.source.contentHash, baseRecipeHash: prior.manifest.importer.recipeHash,
    nextRecipeHash: candidate.manifest.importer.recipeHash });
  const blocked = conflicts.length > 0;
  return Object.freeze({ status: blocked ? "conflicted" : "ready", issues: Object.freeze([]), conflicts,
    preservedOverrides: preserved, diff, execution,
    commit: blocked ? null : freezeCommit(importPlan.commit), version });
}

function buildDiff(previous: readonly DeepAssetResource[], next: readonly DeepAssetResource[]): DeepAssetReimportDiff {
  const oldById = new Map(previous.map(value => [value.id, value])), nextById = new Map(next.map(value => [value.id, value]));
  const unchanged: string[] = [], add: string[] = [], update: DeepAssetResourceUpdate[] = [], remove: string[] = [];
  for (const resource of next) {
    const old = oldById.get(resource.id);
    if (!old) { add.push(resource.id); continue; }
    const changes: DeepAssetResourceChangeField[] = [];
    if (old.kind !== resource.kind) changes.push("kind");
    if (old.logicalPath !== resource.logicalPath) changes.push("logicalPath");
    if (old.blobHash !== resource.blobHash) changes.push("blobHash");
    if (!sameList(old.dependencies, resource.dependencies)) changes.push("dependencies");
    if (changes.length) update.push(Object.freeze({ id: resource.id,
      changes: Object.freeze(changes), renamed: changes.includes("logicalPath") }));
    else unchanged.push(resource.id);
  }
  for (const resource of previous) if (!nextById.has(resource.id)) remove.push(resource.id);
  return Object.freeze({ unchanged: Object.freeze(unchanged), add: Object.freeze(add),
    update: Object.freeze(update), remove: Object.freeze(remove) });
}

function buildExecution(previous: readonly DeepAssetResource[], next: readonly DeepAssetResource[],
  oldOrder: readonly string[], nextOrder: readonly string[], diff: DeepAssetReimportDiff): DeepAssetReimportExecution {
  const byId = new Map(next.map(value => [value.id, value])), reverse = new Map<string, string[]>();
  for (const resource of next) for (const dependency of resource.dependencies) {
    const values = reverse.get(dependency) ?? []; values.push(resource.id); reverse.set(dependency, values);
  }
  const affected = closure([...diff.add, ...diff.update.map(value => value.id)], id => reverse.get(id) ?? []);
  const staged = closure([...affected], id => byId.get(id)?.dependencies ?? []);
  const stageOrder = nextOrder.filter(id => staged.has(id)), publishOrder = nextOrder.filter(id => affected.has(id));
  const removed = new Set(diff.remove), removeOrder = [...oldOrder].reverse().filter(id => removed.has(id));
  return Object.freeze({ stageOrder: Object.freeze(stageOrder), publishOrder: Object.freeze(publishOrder),
    removeOrder: Object.freeze(removeOrder), rollbackOrder: Object.freeze([...stageOrder].reverse()) });
}

function resolveOverrides(overrides: readonly DeepAssetUserOverride[], previous: readonly DeepAssetResource[],
  next: readonly DeepAssetResource[]): { preserved: readonly DeepAssetUserOverride[]; conflicts: readonly DeepAssetOverrideConflict[] } {
  const oldById = new Map(previous.map(value => [value.id, value])), nextById = new Map(next.map(value => [value.id, value]));
  const preserved: DeepAssetUserOverride[] = [], conflicts: DeepAssetOverrideConflict[] = [];
  for (const override of overrides) {
    const old = oldById.get(override.resourceId), candidate = nextById.get(override.resourceId);
    let reason: DeepAssetOverrideConflictReason | undefined;
    if (!candidate) reason = "removed-resource";
    else if (old && old.kind !== candidate.kind) reason = "resource-kind-changed";
    else if (override.baseBlobHash === candidate.blobHash) preserved.push(override);
    else if (old && override.baseBlobHash === old.blobHash) reason = "source-changed";
    else reason = "stale-base";
    if (reason) conflicts.push(Object.freeze({ overrideId: override.id, resourceId: override.resourceId, reason,
      previousBlobHash: old?.blobHash ?? null, nextBlobHash: candidate?.blobHash ?? null }));
  }
  return { preserved: Object.freeze(preserved), conflicts: Object.freeze(conflicts) };
}

function validateOverrides(input: readonly DeepAssetUserOverride[] | undefined,
  issues: DeepAssetReimportIssue[]): readonly DeepAssetUserOverride[] {
  if (input === undefined) return Object.freeze([]);
  if (!Array.isArray(input) || input.length > DEEP_ASSET_PACKAGE_BUDGETS.maxResources) {
    issues.push({ code: "invalid-override", path: "$options.overrides", message: "Expected a bounded override array." }); return [];
  }
  const result: DeepAssetUserOverride[] = [], ids = new Set<string>();
  for (const [index, value] of input.entries()) {
    const path = `$options.overrides[${index}]`;
    if (!isOverride(value) || ids.has(value.id)) {
      if (issues.length < DEEP_ASSET_PACKAGE_BUDGETS.maxIssues) issues.push({ code: "invalid-override", path,
        message: "Override must have only unique stable ids, SHA-256 hashes, and a non-negative revision." });
      continue;
    }
    ids.add(value.id); result.push(Object.freeze({ id: value.id, resourceId: value.resourceId,
      baseBlobHash: value.baseBlobHash, overrideHash: value.overrideHash, revision: value.revision }));
  }
  if (result.some((value, index) => index > 0 && result[index - 1]!.id >= value.id)) {
    issues.push({ code: "invalid-override", path: "$options.overrides", message: "Overrides must be sorted by unique stable id." });
  }
  return Object.freeze(result);
}

function isOverride(value: unknown): value is DeepAssetUserOverride {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) return false;
  const candidate = value as Partial<Record<keyof DeepAssetUserOverride, unknown>>;
  return Object.keys(value).sort().join(",") === "baseBlobHash,id,overrideHash,resourceId,revision"
    && typeof candidate.id === "string" && ID.test(candidate.id)
    && typeof candidate.resourceId === "string" && ID.test(candidate.resourceId)
    && typeof candidate.baseBlobHash === "string" && HASH.test(candidate.baseBlobHash)
    && typeof candidate.overrideHash === "string" && HASH.test(candidate.overrideHash)
    && typeof candidate.revision === "number" && Number.isSafeInteger(candidate.revision) && candidate.revision >= 0;
}

function closure(seeds: readonly string[], edges: (id: string) => readonly string[]): Set<string> {
  const result = new Set<string>(), pending = [...seeds].sort().reverse();
  while (pending.length) {
    const id = pending.pop()!; if (result.has(id)) continue; result.add(id);
    for (const child of [...edges(id)].sort().reverse()) if (!result.has(child)) pending.push(child);
  }
  return result;
}
function sameList(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
function sameActive(active: DeepAssetStoreSnapshot["active"], value: DeepAssetPackage): boolean {
  return active?.packageId === value.manifest.packageId && active.sourceHash === value.manifest.source.contentHash
    && active.recipeHash === value.manifest.importer.recipeHash;
}
function prefixIssues(issues: readonly DeepAssetPackageIssue[], prefix: string): DeepAssetReimportIssue[] {
  return issues.map(issue => ({ ...issue, path: `${prefix}${issue.path === "$" ? "" : issue.path.slice(1)}` }));
}
function freezeCommit(value: DeepAssetImportCommit): DeepAssetImportCommit {
  return Object.freeze({ ...value, nextActive: Object.freeze({ ...value.nextActive }),
    resourceOrder: Object.freeze([...value.resourceOrder]), addBlobHashes: Object.freeze([...value.addBlobHashes]),
    reuseBlobHashes: Object.freeze([...value.reuseBlobHashes]) });
}
function rejected(issues: readonly DeepAssetReimportIssue[]): DeepAssetReimportPlan {
  return Object.freeze({ status: "rejected", issues: Object.freeze([...issues]), conflicts: Object.freeze([]),
    preservedOverrides: Object.freeze([]), diff: null, execution: null, commit: null, version: null });
}
