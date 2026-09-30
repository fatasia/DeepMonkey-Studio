import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import test from "node:test";
import { compareLifecycleTraces } from "./j3LifecycleParity.mjs";

const fixture = JSON.parse(readFileSync(new URL("../../packages/deep-engine/fixtures/j3-lifecycle-v1.json", import.meta.url), "utf8"));
function leg() {
  const samples = fixture.scenarios.map(({ id, expected }) => ({ id, samples: expected }));
  return structuredClone({ scope: fixture.scope, fixture, runs: [samples, samples] });
}

test("compares both complete repeated traces", () => {
  assert.equal(compareLifecycleTraces(fixture, leg(), leg()).passed, true);
});
test("rejects missing scenario evidence", () => {
  const native = leg(); native.runs[0].pop();
  assert.throws(() => compareLifecycleTraces(fixture, leg(), native));
});
test("rejects stable leaked CPU resources", () => {
  const native = leg();
  for (const run of native.runs) run[0].samples.at(-1).cpuResources = 1;
  assert.throws(() => compareLifecycleTraces(fixture, leg(), native));
});
test("rejects stale shared contract", () => {
  const native = leg(); native.fixture.schemaVersion = 2;
  assert.throws(() => compareLifecycleTraces(fixture, leg(), native));
});
test("rejects a phase forbidden by the transition table even if expected traces were changed", () => {
  const changed = structuredClone(fixture);
  changed.scenarios[0].expected[1].phase = "cancelled";
  changed.transitions = changed.transitions.filter(t => t.to !== "cancelled");
  const samples = changed.scenarios.map(({ id, expected }) => ({ id, samples: expected }));
  const value = { scope: changed.scope, fixture: changed, runs: [samples, samples] };
  assert.throws(() => compareLifecycleTraces(changed, value, value));
});
