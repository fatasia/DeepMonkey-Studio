import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { loadCsmBoundaryOracle } from "./loadCsmBoundaryOracle.mjs";
import { compareCsmLinear } from "./j2CsmLinearParity.mjs";
const fixture = JSON.parse(await readFile(new URL("../../packages/deep-engine/fixtures/j2-csm-parity-v1.json", import.meta.url)));
const oracle = await loadCsmBoundaryOracle(), fixtureHash = "fixture";
function leg(ids) {
  const results = ids.flatMap(id => oracle.csmBoundaryCases(fixture).map(row => ({ id, ...row, passed: true,
    sourceHash: "a".repeat(64), libraryHash: "b".repeat(64), values: oracle.csmBoundaryPoints(fixture).map(point =>
      oracle.referenceCsmVisibility(fixture, row, point.depth, point.u)) })));
  return { fixtureHash, passed: true, runs: [0, 1].map(() => ({ results: structuredClone(results), passed: true })) };
}
const web = () => leg(["ts-built-in", "ts-deepsl-package", "native-production-wgsl"]), native = () => leg(["native-production-wgsl"]);
test("independent linear reference reproduces hand-derived PCF fraction", () => {
  const row = { blendStart: 2, filter: "linear", pattern: "edge" };
  assert.ok(Math.abs(oracle.referenceCsmVisibility(fixture, row, 1, .4375) - 7 / 12) < 1e-12);
  assert.ok(Math.abs(oracle.referenceCsmVisibility(fixture, { ...row, filter: "nearest" }, 1, .4375) - 2 / 3) < 1e-12);
});
test("complete common matrix validates all 3136 numerical samples", () => {
  const evidence = compareCsmLinear(fixture, fixtureHash, web(), native(), oracle);
  assert.equal(evidence.samples.chrome, 2352); assert.equal(evidence.samples.native, 784);
});
test("nearest output mislabeled as linear cannot pass CPU oracle", () => {
  const bad = native();
  for (const run of bad.runs) for (const row of run.results.filter(row => row.filter === "linear" && row.pattern === "edge"))
    row.values = run.results.find(other => other.blendStart === row.blendStart && other.filter === "nearest" && other.pattern === "edge").values;
  assert.throws(() => compareCsmLinear(fixture, fixtureHash, web(), bad, oracle), /oracle\/filter/);
});
test("stale fixture, missing case, different sampling library and repeated drift fail", () => {
  const stale = native(); stale.fixtureHash = "old";
  assert.throws(() => compareCsmLinear(fixture, fixtureHash, web(), stale, oracle), /fixture/);
  const missing = native(); missing.runs.forEach(run => run.results.pop());
  assert.throws(() => compareCsmLinear(fixture, fixtureHash, web(), missing, oracle), /missing/);
  const source = native(); source.runs.forEach(run => run.results.forEach(row => { row.libraryHash = "c".repeat(64); }));
  assert.throws(() => compareCsmLinear(fixture, fixtureHash, web(), source, oracle), /source differs/);
  const drift = native(); drift.runs[1].results[0].values[0] += .1;
  assert.throws(() => compareCsmLinear(fixture, fixtureHash, web(), drift, oracle), /repeated/);
});
