import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";

const run = promisify(execFile);
const root = path.resolve(import.meta.dirname, "..");
const script = path.join(root, "scripts/verify-de26-readiness-evidence.mjs");

test("readiness packet preserves blocked status and derived-statistics boundary", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "de26-readiness-"));
  await writeFile(path.join(temp, "readiness.json"), JSON.stringify({
    schema: "deep-engine.de26-asset-readiness", schemaVersion: 1, status: "blocked",
    requiredLoadClasses: ["dynamic-workcell", "mixed-dashboard"],
    checks: [{ id: "required-load-classes", status: "blocked", summary: "missing", reasons: ["missing load class: mixed-dashboard"] },
      { id: "measured-stats", status: "unverified", summary: "missing", reasons: ["asset.rvt: missing triangles"] }],
  }));
  await writeFile(path.join(temp, "prepared-statistics.json"), JSON.stringify({ schemaVersion: 1, source: "inspect-de26-local-benchmarks.mts", assets: [{ name: "LocalBim", triangles: 10, geometries: 2, instances: 3, materials: 1, textures: 0 }] }));
  const manifestPath = path.join(root, "packages/deep-engine/fixtures/benchmark-assets/manifests-v1.json");
  const original = await readFile(manifestPath, "utf8");
  const sourceSha256 = "a".repeat(64);
  const sourceReport = JSON.stringify({ sourceSha256, status: "unsupported-version", revitVersion: 2017, geometry: "missing" });
  const sourceReportPath = path.join(temp, `${sourceSha256}.json`);
  await writeFile(sourceReportPath, sourceReport);
  const auditPath = path.join(temp, "source-audit.json");
  await writeFile(auditPath, JSON.stringify({ schemaVersion: 1, scope: "inspect-source-identities-only", results: [{
    sourceSha256, reportSha256: createHash("sha256").update(sourceReport).digest("hex"), status: "unsupported-version", version: 2017,
  }] }));
  await run(process.execPath, [script, temp, auditPath], { cwd: root });
  const packet = JSON.parse(await readFile(path.join(temp, "readiness-evidence.json"), "utf8"));
  assert.equal(packet.status, "blocked");
  assert.equal(packet.coverage.loadClasses.ratio, 1);
  assert.equal(packet.derivedStatistics.authoritative, false);
  assert.match(packet.derivedStatistics.boundary, /not source RVT/);
  assert.equal(packet.gaps.length, 2);
  assert.ok(original.length > 0);
  assert.deepEqual(packet.sourceRvtAudit.results[0].matchedManifestIds, []);
  await writeFile(sourceReportPath, `${sourceReport} `);
  await assert.rejects(run(process.execPath, [script, temp, auditPath], { cwd: root }), /hash mismatch/);
  await writeFile(auditPath, "{broken");
  await assert.rejects(run(process.execPath, [script, temp, auditPath], { cwd: root }));
  await assert.rejects(run(process.execPath, [script, temp, path.join(temp, "missing.json")], { cwd: root }));
});
