/**
 * DE26/A02/A08: build an auditable readiness packet from existing evidence.
 *
 * This deliberately does not promote derived GLB statistics into source-asset
 * statistics.  The packet is useful for closure tracking while the source RVT
 * geometry remains unmeasured.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const output = path.resolve(root, process.argv[2] ?? "test-output/de26-local-assets-readiness-20260918");
const readinessPath = path.join(output, "readiness.json");
const preparedPath = path.join(output, "prepared-statistics.json");
const manifestPath = path.join(root, "packages/deep-engine/fixtures/benchmark-assets/manifests-v1.json");
const destination = path.join(output, "readiness-evidence.json");
const sourceAuditPath = path.resolve(root, process.argv[3] ?? "test-output/de26-rvt-source-audit-20260919-r4/evidence.json");

const parse = (value, label) => {
  if (!value || typeof value !== "object") throw new Error(`${label} must be an object`);
  return value;
};
const readiness = parse(JSON.parse(await readFile(readinessPath, "utf8")), "readiness.json");
const prepared = parse(JSON.parse(await readFile(preparedPath, "utf8")), "prepared-statistics.json");
const manifestDocument = parse(JSON.parse(await readFile(manifestPath, "utf8")), "manifests-v1.json");
let sourceAudit = null;
try {
  sourceAudit = parse(JSON.parse(await readFile(sourceAuditPath, "utf8")), "RVT source audit");
} catch (error) {
  if (error.code !== "ENOENT" || process.argv[3]) throw error;
}
const manifests = Array.isArray(manifestDocument.manifests) ? manifestDocument.manifests : [];
const sourceAuditResults = [];
if (sourceAudit) {
  if (sourceAudit.schemaVersion !== 1
    || !["inspect-source-identities-only", "source-statistics-aggregate"].includes(sourceAudit.scope)
    || !Array.isArray(sourceAudit.results)) throw new Error("Unsupported RVT audit provenance");
  for (const result of sourceAudit.results) {
    if (!/^[a-f0-9]{64}$/.test(result.sourceSha256) || !/^[a-f0-9]{64}$/.test(result.reportSha256)) {
      throw new Error("Invalid RVT audit digest");
    }
    const bytes = await readFile(path.join(path.dirname(sourceAuditPath), `${result.sourceSha256}.json`));
    if (createHash("sha256").update(bytes).digest("hex") !== result.reportSha256) throw new Error("RVT audit report hash mismatch");
    const report = JSON.parse(bytes);
    if (report.sourceSha256 !== result.sourceSha256 || report.status !== result.status
      || report.revitVersion !== result.version) throw new Error("RVT audit report identity mismatch");
    if (sourceAudit.scope === "inspect-source-identities-only"
      && report.geometry !== "missing") throw new Error("RVT audit report identity mismatch");
    if (sourceAudit.scope === "source-statistics-aggregate") {
      if (report.quality !== "inspect" || !report.statistics || typeof report.statistics !== "object") {
        throw new Error("RVT statistics report missing statistics object");
      }
      // 诚实条款:builtin 读取器没有 tessellation,包必须显式声明这些字段
      // 未测量,禁止把派生 GLB 统计冒充源级统计。
      const unmeasured = Array.isArray(report.statistics.unmeasured) ? report.statistics.unmeasured : [];
      for (const field of ["triangles", "meshes", "textures"]) {
        if (!unmeasured.includes(field)) throw new Error(`RVT statistics must declare ${field} unmeasured`);
      }
    }
    const matched = manifests.filter(item => item.source?.format === "rvt" && item.source?.sha256 === result.sourceSha256);
    sourceAuditResults.push({ ...result, matchedManifestIds: matched.map(item => item.id) });
  }
}
const requiredLoadClasses = Array.isArray(readiness.requiredLoadClasses) ? readiness.requiredLoadClasses : [];
const presentLoadClasses = new Set(manifests.map((item) => item?.primaryLoadClass).filter((value) => typeof value === "string"));
const requiredTaskKinds = ["appearance", "animation", "dashboard"];
const presentTaskKinds = new Set(manifests.flatMap((item) => Array.isArray(item?.tasks) ? item.tasks : [])
  .map((task) => task?.kind).filter((value) => typeof value === "string"));
const ratio = (present, required) => required.length === 0 ? 1 : present.filter((item) => required.includes(item)).length / required.length;
const checks = Array.isArray(readiness.checks) ? readiness.checks : [];
const gaps = checks.filter((check) => check?.status === "blocked" || check?.status === "unverified")
  .map((check) => ({ id: check.id, status: check.status, summary: check.summary, reasons: Array.isArray(check.reasons) ? check.reasons : [] }));
const derivedAssets = Array.isArray(prepared.assets) ? prepared.assets.map((asset) => ({
  name: asset?.name ?? null,
  statistics: {
    triangles: asset?.triangles ?? null,
    geometries: asset?.geometries ?? null,
    instances: asset?.instances ?? null,
    materials: asset?.materials ?? null,
    textures: asset?.textures ?? null,
  },
})) : [];
if (prepared.schemaVersion !== 1 || prepared.source !== "inspect-de26-local-benchmarks.mts") {
  throw new Error("prepared-statistics.json has an unsupported provenance");
}
for (const asset of derivedAssets) {
  for (const [field, value] of Object.entries(asset.statistics)) {
    if (!Number.isFinite(value) || value < 0) throw new Error(`derived statistic ${asset.name}.${field} is invalid`);
  }
}
const packet = {
  schema: "deep-engine.de26-readiness-evidence",
  schemaVersion: 1,
  status: readiness.status,
  generatedFrom: {
    readiness: path.relative(root, readinessPath).replaceAll("\\", "/"),
    preparedStatistics: path.relative(root, preparedPath).replaceAll("\\", "/"),
    manifest: path.relative(root, manifestPath).replaceAll("\\", "/"),
    ...(sourceAudit ? { sourceAudit: path.relative(root, sourceAuditPath).replaceAll("\\", "/") } : {}),
  },
  coverage: {
    loadClasses: { required: requiredLoadClasses, present: [...presentLoadClasses].sort(), ratio: ratio([...presentLoadClasses], requiredLoadClasses) },
    taskKinds: { required: requiredTaskKinds, present: [...presentTaskKinds].sort(), ratio: ratio([...presentTaskKinds], requiredTaskKinds) },
  },
  gaps,
  sourceRvtAudit: sourceAudit ? {
    scope: sourceAudit.scope,
    results: sourceAuditResults,
    boundary: "source identity/version evidence only; unsupported-version or zero-identity results do not become geometry statistics",
  } : { status: "missing", boundary: "No source RVT audit packet supplied" },
  sourceRvtStatistics: sourceAudit?.scope === "source-statistics-aggregate" ? {
    scope: sourceAudit.scope,
    results: sourceAuditResults.map((result) => ({
      assetIds: result.matchedManifestIds,
      status: result.status,
      revitVersion: result.version,
      build: result.build ?? null,
      statistics: result.statistics,
      failures: result.failures,
    })),
    boundary: "source-level aggregate statistics parsed from the source RVT bytes by the builtin local reader; header-validated instance counts make no geometry claim; tessellated triangle/mesh/texture counts remain unmeasured and are never substituted from derived GLB statistics",
  } : undefined,
  derivedStatistics: {
    authoritative: false,
    boundary: "derived GLB packet statistics; not source RVT geometry statistics",
    source: prepared.source,
    assets: derivedAssets,
  },
};
await mkdir(output, { recursive: true });
await writeFile(destination, `${JSON.stringify(packet, null, 2)}\n`);
console.log(JSON.stringify({ status: packet.status, destination, loadClassRatio: packet.coverage.loadClasses.ratio, taskKindRatio: packet.coverage.taskKinds.ratio, gapCount: gaps.length }));
