/** DE26/A02 · 基准资产清单合同 v1:真实项目入库的固定身份、单位、许可与任务夹具。
 *  资产字节不入库;清单(哈希+路径+许可+统计)入库并可复算。 */

export const BENCHMARK_ASSET_MANIFEST_SCHEMA_VERSION = 1 as const;

/** 与 A01 目标矩阵的六类负载对齐;资产按主要负载归类,允许附带次级任务夹具。 */
export type BenchmarkLoadClass =
  | "factory-instances"
  | "heterogeneous-bim"
  | "far-origin-campus"
  | "dynamic-workcell"
  | "mixed-dashboard"
  | "appearance-showcase";

export interface BenchmarkAssetSource {
  /** 仓库相对或绝对路径;字节不入 git,哈希必须可按路径复算。 */
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly format: "rvt" | "rfa" | "glb" | "gltf" | "ifc" | "obj";
  /** 来源格式版本(如 Revit 年份);未知必须是 "unknown" 而不能编造。 */
  readonly formatVersion: string;
}

export interface BenchmarkAssetLicense {
  readonly redistributable: boolean;
  /** 许可证据:许可名+获取方式;不可再分发必须写明本机基准用途边界。 */
  readonly evidence: string;
}

export interface BenchmarkAssetTaskFixture {
  readonly kind: "appearance" | "animation" | "dashboard";
  /** 夹具脚本/相机的稳定标识;轨迹字节在 A03 采样冻结时落盘。 */
  readonly fixtureId: string;
}

export interface BenchmarkAssetManifest {
  readonly schema: "deep-engine.benchmark-asset-manifest";
  readonly schemaVersion: typeof BENCHMARK_ASSET_MANIFEST_SCHEMA_VERSION;
  readonly id: string;
  readonly name: string;
  readonly domain: "factory" | "bim" | "campus";
  readonly primaryLoadClass: BenchmarkLoadClass;
  readonly source: BenchmarkAssetSource;
  /** 源格式单位,如 "mm" / "feet";禁止改写数值迁就目标单位。 */
  readonly units: string;
  readonly license: BenchmarkAssetLicense;
  /** 转换前未知维度如实缺省;转换后由 C01/C07 回填,不允许估算冒充实测。 */
  readonly stats?: {
    readonly triangles?: number;
    readonly materials?: number;
    readonly instances?: number;
    readonly measuredBy?: string;
  };
  readonly tasks: readonly BenchmarkAssetTaskFixture[];
  /** 冷/热缓存测量条件在领取 A03/A04 时引用,这里冻结声明。 */
  readonly cacheConditions: readonly ("cold" | "warm")[];
}

export interface ManifestValidationIssue {
  readonly field: string;
  readonly message: string;
}

const SHA256 = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const FORMATS = new Set(["rvt", "rfa", "glb", "gltf", "ifc", "obj"]);
const LOAD_CLASSES = new Set<BenchmarkLoadClass>(["factory-instances", "heterogeneous-bim", "far-origin-campus", "dynamic-workcell", "mixed-dashboard", "appearance-showcase"]);
const TASK_KINDS = new Set(["appearance", "animation", "dashboard"]);

export function validateBenchmarkAssetManifest(manifest: BenchmarkAssetManifest): readonly ManifestValidationIssue[] {
  const issues: ManifestValidationIssue[] = [];
  const fail = (field: string, message: string) => issues.push({ field, message });
  if (manifest.schema !== "deep-engine.benchmark-asset-manifest" || manifest.schemaVersion !== BENCHMARK_ASSET_MANIFEST_SCHEMA_VERSION) {
    fail("schema", "schema identity mismatch");
  }
  if (!ID.test(manifest.id)) fail("id", "manifest id is invalid");
  if (!manifest.name.trim()) fail("name", "name is empty");
  if (!["factory", "bim", "campus"].includes(manifest.domain)) fail("domain", "domain must be factory, bim or campus");
  if (!LOAD_CLASSES.has(manifest.primaryLoadClass)) fail("primaryLoadClass", "primary load class is not one of the six frozen classes");
  const source = manifest.source;
  if (!source) fail("source", "source is required");
  else {
    if (!source.path.trim() || /[<>:"|?*\u0000-\u001f]/.test(source.path) && !/^[A-Za-z]:[\\/]/.test(source.path)) fail("source.path", "asset path is invalid");
    if (!Number.isSafeInteger(source.bytes) || source.bytes <= 0) fail("source.bytes", "byte size must be a positive integer");
    if (!SHA256.test(source.sha256)) fail("source.sha256", "asset hash must be lowercase SHA-256");
    if (!FORMATS.has(source.format)) fail("source.format", "format is not an accepted source format");
    if (!source.formatVersion.trim()) fail("source.formatVersion", "format version is required (use \"unknown\" honestly)");
  }
  if (!manifest.units.trim()) fail("units", "source units are required");
  if (!manifest.license?.evidence.trim()) fail("license.evidence", "license evidence is required");
  const taskIds = new Set<string>();
  for (const task of manifest.tasks ?? []) {
    if (!TASK_KINDS.has(task.kind)) fail("tasks", `task kind ${String(task.kind)} is invalid`);
    if (!ID.test(task.fixtureId)) fail("tasks", `fixture id ${task.fixtureId} is invalid`);
    if (taskIds.has(task.fixtureId)) fail("tasks", `duplicate fixture id ${task.fixtureId}`);
    taskIds.add(task.fixtureId);
  }
  if (!(manifest.tasks ?? []).length) fail("tasks", "at least one task fixture is required");
  const caches = manifest.cacheConditions ?? [];
  if (!caches.length || new Set(caches).size !== caches.length || caches.some(condition => condition !== "cold" && condition !== "warm")) {
    fail("cacheConditions", "cache conditions must be a unique non-empty subset of cold/warm");
  }
  if (manifest.stats?.triangles !== undefined && (!Number.isSafeInteger(manifest.stats.triangles) || manifest.stats.triangles < 0)) {
    fail("stats.triangles", "triangles must be a non-negative integer when present");
  }
  return issues;
}

export function createBenchmarkAssetManifest(manifest: BenchmarkAssetManifest): BenchmarkAssetManifest {
  const issues = validateBenchmarkAssetManifest(manifest);
  if (issues.length) throw new Error(`invalid benchmark asset manifest ${manifest.id}: ${issues.map(issue => `${issue.field}: ${issue.message}`).join("; ")}`);
  return manifest;
}
