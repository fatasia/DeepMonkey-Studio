/**
 * DE26/A02+A08 · 资产/证据就绪盘点合同。
 *
 * 这层只汇总已经冻结的 manifest、trajectory 和本轮实际观测，不读取 GPU、
 * 不猜测分发许可，也不把“文件存在”提升成“可用于评分”。调用方可将
 * inventory 直接序列化为审计证据；同一输入始终得到同一结果。
 */
import {
  validateBenchmarkAssetManifest,
  type BenchmarkAssetManifest,
  type BenchmarkAssetTaskFixture,
  type BenchmarkLoadClass,
} from "./benchmarkAssetManifest.js";
import {
  validateBenchmarkTrajectory,
  type BenchmarkTrajectory,
} from "./benchmarkAssetTrajectory.js";

export const BENCHMARK_READINESS_SCHEMA_VERSION = 1 as const;

export type ReadinessStatus = "measured" | "blocked" | "unverified";

export interface ObservedAssetSource {
  readonly bytes: number;
  readonly sha256: string;
}

export interface BenchmarkReadinessInput {
  readonly manifests: readonly BenchmarkAssetManifest[];
  readonly trajectories: readonly BenchmarkTrajectory[];
  /** 由本机 hash 复核器提供；缺省表示本轮没有做源文件复核。 */
  readonly observedSources?: Readonly<Record<string, ObservedAssetSource>>;
  /** 默认是 A02 六类负载；测试或增量批次可显式缩小，但生产报告应使用默认值。 */
  readonly requiredLoadClasses?: readonly BenchmarkLoadClass[];
  /** A02 的三种任务夹具；dashboard 不要求出现在相机轨迹中。 */
  readonly requiredTaskKinds?: readonly ("appearance" | "animation" | "dashboard")[];
  readonly minimumAssetCount?: number;
}

export interface ReadinessCheck {
  readonly id: string;
  readonly status: ReadinessStatus;
  readonly summary: string;
  readonly reasons: readonly string[];
}

export interface AssetReadiness {
  readonly id: string;
  readonly status: ReadinessStatus;
  readonly manifestIssues: readonly string[];
  readonly source: {
    readonly status: ReadinessStatus;
    readonly declaredBytes: number | null;
    readonly declaredSha256: string | null;
    readonly observedBytes: number | null;
    readonly observedSha256: string | null;
    readonly reason: string | null;
  };
  readonly taskFixtures: readonly string[];
  readonly missingTrajectoryFixtures: readonly string[];
  readonly missingStats: readonly string[];
}

export interface BenchmarkReadinessInventory {
  readonly schema: "deep-engine.de26-asset-readiness";
  readonly schemaVersion: typeof BENCHMARK_READINESS_SCHEMA_VERSION;
  readonly status: ReadinessStatus;
  readonly requiredLoadClasses: readonly BenchmarkLoadClass[];
  readonly checks: readonly ReadinessCheck[];
  readonly assets: readonly AssetReadiness[];
  readonly trajectoryIds: readonly string[];
}

export const DE26_REQUIRED_LOAD_CLASSES: readonly BenchmarkLoadClass[] = [
  "factory-instances",
  "heterogeneous-bim",
  "far-origin-campus",
  "dynamic-workcell",
  "mixed-dashboard",
  "appearance-showcase",
] as const;

export const DE26_REQUIRED_TASK_KINDS: readonly ("appearance" | "animation" | "dashboard")[] = [
  "appearance", "animation", "dashboard",
] as const;

const TRAJECTORY_TASK_KINDS = new Set(["appearance", "animation", "interaction"]);
const REQUIRED_STATS = ["triangles", "materials", "meshes", "textures", "bounds"] as const;

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function aggregateStatus(statuses: readonly ReadinessStatus[]): ReadinessStatus {
  if (statuses.includes("blocked")) return "blocked";
  if (statuses.includes("unverified")) return "unverified";
  return "measured";
}

function check(id: string, status: ReadinessStatus, summary: string, reasons: readonly string[] = []): ReadinessCheck {
  return { id, status, summary, reasons: unique(reasons) };
}

function safeManifestIssues(manifest: BenchmarkAssetManifest): string[] {
  try {
    return validateBenchmarkAssetManifest(manifest).map((issue) => `${issue.field}: ${issue.message}`);
  } catch (error) {
    return [`validator threw: ${error instanceof Error ? error.message : String(error)}`];
  }
}

function safeTrajectoryIssues(trajectory: BenchmarkTrajectory): string[] {
  try {
    return validateBenchmarkTrajectory(trajectory).map((issue) => `${issue.field}: ${issue.message}`);
  } catch (error) {
    return [`validator threw: ${error instanceof Error ? error.message : String(error)}`];
  }
}

function isTaskFixture(value: unknown): value is BenchmarkAssetTaskFixture {
  return Boolean(value) && typeof value === "object";
}

function taskFixturesOf(manifest: BenchmarkAssetManifest): readonly BenchmarkAssetTaskFixture[] {
  const value = (manifest as BenchmarkAssetManifest & { tasks?: unknown }).tasks;
  return Array.isArray(value) ? value.filter(isTaskFixture) : [];
}

/** 构造 A02/A08 机器清单；不会因缺 GPU/发布包而生成伪造的 measured。 */
export function buildBenchmarkReadinessInventory(input: BenchmarkReadinessInput): BenchmarkReadinessInventory {
  const requiredLoadClasses = [...(input.requiredLoadClasses ?? DE26_REQUIRED_LOAD_CLASSES)];
  const requiredTaskKinds = [...(input.requiredTaskKinds ?? DE26_REQUIRED_TASK_KINDS)];
  const minimumAssetCount = input.minimumAssetCount ?? 3;
  const manifests = Array.isArray(input.manifests) ? input.manifests : [];
  const trajectories = Array.isArray(input.trajectories) ? input.trajectories : [];
  const trajectoryIds = trajectories.map((trajectory) =>
    trajectory && typeof trajectory === "object" && typeof trajectory.id === "string" ? trajectory.id : undefined)
    .filter((id): id is string => typeof id === "string");
  const trajectoryIdSet = new Set(trajectoryIds);
  const duplicateTrajectoryIds = trajectoryIds.filter((id, index) => trajectoryIds.indexOf(id) !== index);
  const manifestIds = new Set<string>();
  const trajectoryValidationIssues = trajectories.flatMap((trajectory) =>
    safeTrajectoryIssues(trajectory).map((issue) => `${String(trajectory?.id ?? "<missing-id>")}: ${issue}`));
  const duplicateManifestIds: string[] = [];
  const assets: AssetReadiness[] = manifests.map((manifest) => {
    const candidate = (manifest && typeof manifest === "object" ? manifest : {}) as BenchmarkAssetManifest;
    const assetId = typeof candidate.id === "string" ? candidate.id : "<missing-id>";
    if (manifestIds.has(assetId)) duplicateManifestIds.push(assetId);
    manifestIds.add(assetId);
    const manifestIssues = safeManifestIssues(candidate);
    const observed = input.observedSources?.[assetId];
    let sourceStatus: ReadinessStatus = "unverified";
    let sourceReason: string | null = "source bytes/hash were not observed in this run";
    if (manifestIssues.length) {
      sourceStatus = "blocked";
      sourceReason = "manifest is invalid; source identity cannot be trusted";
    } else if (observed) {
      const observationShapeInvalid = !Number.isSafeInteger(observed.bytes) || observed.bytes <= 0
        || !/^[a-f0-9]{64}$/.test(observed.sha256);
      const byteMismatch = observed.bytes !== candidate.source.bytes;
      const hashMismatch = observed.sha256 !== candidate.source.sha256;
      if (observationShapeInvalid) {
        sourceStatus = "blocked";
        sourceReason = "observed source identity has an invalid byte count or SHA-256";
      } else if (byteMismatch || hashMismatch) {
        sourceStatus = "blocked";
        sourceReason = [byteMismatch ? "byte count differs" : "", hashMismatch ? "SHA-256 differs" : ""]
          .filter(Boolean).join("; ");
      } else {
        sourceStatus = "measured";
        sourceReason = null;
      }
    }
    const tasks = taskFixturesOf(candidate);
    const trajectoryTasks = tasks.filter((task) => task && TRAJECTORY_TASK_KINDS.has(task.kind));
    const missingTrajectoryFixtures = trajectoryTasks
      .filter((task) => !trajectoryIdSet.has(task.fixtureId)).map((task) => task.fixtureId);
    const missingStats = candidate.stats
      ? REQUIRED_STATS.filter((field) => candidate.stats?.[field] === undefined)
      : [...REQUIRED_STATS];
    const status = aggregateStatus([
      manifestIssues.length ? "blocked" : "measured",
      sourceStatus,
      missingTrajectoryFixtures.length ? "blocked" : "measured",
      missingStats.length ? "unverified" : "measured",
    ]);
    return {
      id: assetId,
      status,
      manifestIssues,
      source: {
        status: sourceStatus,
        declaredBytes: candidate.source?.bytes ?? null,
        declaredSha256: candidate.source?.sha256 ?? null,
        observedBytes: observed?.bytes ?? null,
        observedSha256: observed?.sha256 ?? null,
        reason: sourceReason,
      },
      taskFixtures: tasks.map((task) => task.fixtureId),
      missingTrajectoryFixtures: unique(missingTrajectoryFixtures),
      missingStats,
    };
  });

  const classesPresent = new Set(manifests.map((manifest) => manifest?.primaryLoadClass));
  const missingClasses = requiredLoadClasses.filter((loadClass) => !classesPresent.has(loadClass));
  const taskKindsPresent = new Set(manifests.flatMap((manifest) =>
    taskFixturesOf(manifest)
      .map((task) => task.kind)));
  const missingTaskKinds = requiredTaskKinds.filter((kind) => !taskKindsPresent.has(kind));
  const assetCountReasons = manifests.length >= minimumAssetCount
    ? [] : [`at least ${minimumAssetCount} assets are required; found ${manifests.length}`];
  const sourceStatuses = assets.map((asset) => asset.source.status);
  const sourceCheckStatus = aggregateStatus(sourceStatuses.length ? sourceStatuses : ["unverified"]);
  const sourceReasons = assets.flatMap((asset) => asset.source.reason ? [`${asset.id}: ${asset.source.reason}`] : []);
  const manifestReasons = assets.flatMap((asset) => asset.manifestIssues.map((issue) => `${asset.id}: ${issue}`));
  const taskReasons = assets.flatMap((asset) => asset.missingTrajectoryFixtures.map((fixture) => `${asset.id}: missing ${fixture}`));
  const statsReasons = assets.flatMap((asset) => asset.missingStats.length
    ? [`${asset.id}: missing ${asset.missingStats.join(", ")}`] : []);
  const cacheReasons = manifests.flatMap((manifest) => {
    const conditions = new Set(Array.isArray(manifest?.cacheConditions) ? manifest.cacheConditions : []);
    return conditions.has("cold") && conditions.has("warm") ? [] : [`${manifest?.id ?? "<missing-id>"}: cold and warm cache conditions are required`];
  });
  const licenseReasons = manifests.flatMap((manifest) => {
    const evidence = manifest?.license?.evidence;
    const license = manifest?.license;
    const reasons: string[] = [];
    if (typeof license?.redistributable !== "boolean") reasons.push("redistributable flag is missing or invalid");
    if (typeof evidence !== "string" || !evidence.trim()) reasons.push("license evidence is missing");
    return reasons.map((reason) => `${manifest?.id ?? "<missing-id>"}: ${reason}`);
  });

  const checks: ReadinessCheck[] = [
    check("minimum-asset-count", assetCountReasons.length ? "blocked" : "measured",
      assetCountReasons.length ? "the minimum real-asset count is not met" : `at least ${minimumAssetCount} assets are present`, assetCountReasons),
    check("manifest-contract", manifestReasons.length ? "blocked" : "measured",
      manifestReasons.length ? "one or more manifests fail schema validation" : "all manifests satisfy the v1 contract", manifestReasons),
    check("manifest-identity", duplicateManifestIds.length ? "blocked" : "measured",
      duplicateManifestIds.length ? "manifest IDs are duplicated" : "manifest IDs are unique",
      duplicateManifestIds.map((id) => `duplicate id: ${id}`)),
    check("required-load-classes", missingClasses.length ? "blocked" : "measured",
      missingClasses.length ? "A02 load-class coverage is incomplete" : "all six A02 load classes are represented",
      missingClasses.map((loadClass) => `missing load class: ${loadClass}`)),
    check("task-coverage", missingTaskKinds.length ? "blocked" : "measured",
      missingTaskKinds.length ? "A02 task-fixture coverage is incomplete" : "appearance, animation and dashboard fixtures are represented",
      missingTaskKinds.map((kind) => `missing task kind: ${kind}`)),
    check("trajectory-contract", trajectoryValidationIssues.length ? "blocked" : "measured",
      trajectoryValidationIssues.length ? "one or more trajectories fail schema validation" : "all trajectories satisfy the v1 contract",
      trajectoryValidationIssues),
    check("trajectory-identity", duplicateTrajectoryIds.length ? "blocked" : "measured",
      duplicateTrajectoryIds.length ? "trajectory IDs are duplicated" : "trajectory IDs are unique",
      unique(duplicateTrajectoryIds).map((id) => `duplicate id: ${id}`)),
    check("trajectory-references", taskReasons.length ? "blocked" : "measured",
      taskReasons.length ? "one or more asset task fixtures are dangling" : "all appearance/animation/interaction fixtures resolve",
      taskReasons),
    check("source-integrity", sourceCheckStatus,
      sourceCheckStatus === "measured" ? "all declared source bytes and hashes match this run"
        : sourceCheckStatus === "blocked" ? "at least one observed source differs from its frozen identity"
          : "source bytes and hashes were not observed in this run", sourceReasons),
    check("measured-stats", statsReasons.length ? "unverified" : "measured",
      statsReasons.length ? "some assets lack exact geometry/material statistics" : "all assets carry exact v1 statistics", statsReasons),
    check("cache-conditions", cacheReasons.length ? "blocked" : "measured",
      cacheReasons.length ? "cold and warm cache conditions are incomplete" : "cold and warm cache conditions are declared for every asset", cacheReasons),
    check("license-boundary", licenseReasons.length ? "blocked" : "measured",
      licenseReasons.length ? "one or more assets lack license evidence" : "every asset has an explicit license boundary", licenseReasons),
  ];
  return {
    schema: "deep-engine.de26-asset-readiness",
    schemaVersion: BENCHMARK_READINESS_SCHEMA_VERSION,
    status: aggregateStatus([...checks.map((item) => item.status), ...assets.map((item) => item.status)]),
    requiredLoadClasses,
    checks,
    assets,
    trajectoryIds,
  };
}
