import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { median, parseNativeReport, tableCells } from "./deep-native-bench-metrics.mjs";

const sha256 = value => createHash("sha256").update(value).digest("hex");
export async function checkEvidence(root, output) {
  const summary = JSON.parse(await readFile(path.join(output, "summary.json"), "utf8"));
  assert.equal(summary.schema, "deep-engine.native-benchmark-summary");
  assert.equal(summary.schemaVersion, 2);
  assert.equal(summary.probe, false);
  assert.equal(summary.protocol.presentedFrames, 512);
  assert.equal(summary.protocol.warmupFrames, 120);
  assert.equal(summary.protocol.rounds, 3);
  assert.equal(summary.protocol.rebuildCycles, 20);
  assert.deepEqual(summary.cases.map(item => [item.workload, item.objectCount]),
    [["static", 120], ["static", 1000], ["dynamic", 1000], ["rebuild", 1000]]);
  assert.equal(sha256(await readFile(path.join(output, summary.executable.sourceManifest))), summary.executable.sourceManifestSha256);
  for (const item of summary.cases) {
    const fixtureFile = path.join(output, "runs", summary.runId, `fixture-${item.objectCount}.runtime-package.json`);
    const bytes = await readFile(fixtureFile);
    assert.equal(sha256(bytes), item.fileSha256);
    assert.equal(JSON.parse(bytes).packageHash.value, item.packageHash);
    const actual = [];
    for (const run of item.runs) {
      const evidence = await readFile(path.join(output, run.evidence), "utf8");
      assert.equal(sha256(evidence), run.evidenceSha256);
      const log = await readFile(path.join(output, run.evidence.replace(".telemetry.json", ".stdout.log")), "utf8");
      const parsed = parseNativeReport(log, { count: item.objectCount, frames: item.workload === "rebuild" ? 20 : 512,
        workload: item.workload, warmup: 120, packageHash: item.packageHash });
      assert.equal(evidence, parsed.raw + "\n");
      assert.deepEqual(parsed.frames, run.frames);
      const launchBytes = await readFile(path.join(output, run.launchEvidence));
      assert.equal(sha256(launchBytes), run.launchSha256);
      const launch = JSON.parse(launchBytes);
      assert.equal(launch.observedMonotonicMs - launch.startedMonotonicMs, launch.firstFrameMs);
      assert(Number.isFinite(launch.firstFrameMs) && launch.firstFrameMs > 0);
      assert(log.split(/\r?\n/).includes(launch.marker));
      const benchmark = { ...parsed.benchmark, firstFrameMs: launch.firstFrameMs };
      assert.deepEqual(benchmark, run.benchmark);
      actual.push({ ...parsed.frames, ...benchmark });
    }
    assert.equal(actual.length, 3);
    for (const [key, value] of Object.entries(item.median)) assert.equal(median(actual.map(run => run[key])), value, key);
    console.log(`Verified ${item.workload}/${item.objectCount}: 3 raw reports, launch records, hashes and medians`);
  }
  for (const file of ["README.md", "README.en.md"]) {
    const lines = (await readFile(path.join(root, file), "utf8")).split(/\r?\n/);
    for (const [labels, expected] of tableCells(summary)) {
      const row = lines.find(line => labels.some(label => line.startsWith(label)));
      assert.equal(row?.split("|").at(-2)?.trim(), expected, `${file}: Deep Native cell must equal ${expected}`);
    }
  }
  console.log("Verified all nine Chinese and English README Deep Native cells.");
}
