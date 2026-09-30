import assert from "node:assert/strict";

/** Checks observed host traces, never computes host state transitions. */
export function compareLifecycleTraces(fixture, web, native) {
  assert.equal(fixture.schema, "deep-engine.j3-lifecycle");
  assert.equal(fixture.schemaVersion, 1);
  assert.deepEqual(web.fixture, fixture, "TS fixture freshness");
  assert.deepEqual(native.fixture, fixture, "native fixture freshness");
  assert.equal(web.scope, fixture.scope);
  assert.equal(native.scope, fixture.scope);
  const expected = fixture.scenarios.map(({ id, expected }) => ({ id, samples: expected }));
  for (const [host, leg] of [["TS", web], ["native", native]]) {
    assert.equal(leg.runs.length, 2, `${host} repeat count`);
    assert.deepEqual(leg.runs[0], leg.runs[1], `${host} repeat stability`);
    for (const [round, scenarios] of leg.runs.entries()) {
      assert.deepEqual(scenarios, expected, `${host} round ${round + 1} observed trace versus contract`);
      for (const scenario of scenarios) {
        const requests = new Map();
        let disposed = false;
        for (const sample of scenario.samples) {
          assert.ok(fixture.phases.includes(sample.phase), `${host} registered phase`);
          assert.ok(Number.isSafeInteger(sample.cpuResources) && sample.cpuResources >= 0, "CPU resource count");
          if (sample.phase === "disposed") {
            assert.ok(fixture.transitions.some(t => t.from === (disposed ? "disposed" : "host") && t.to === "disposed"));
            assert.equal(sample.activeGeneration, 0);
            assert.equal(sample.cpuResources, 0);
            disposed = true;
          } else {
            const previous = requests.get(sample.generation) ?? null;
            assert.ok(fixture.transitions.some(t => t.from === previous && t.to === sample.phase), "registered request transition");
            requests.set(sample.generation, sample.phase);
            if (disposed) {
              assert.equal(sample.phase, "superseded", "late completion after disposal");
              assert.equal(sample.activeGeneration, 0);
              assert.equal(sample.cpuResources, 0);
            }
          }
        }
        assert.equal(scenario.samples.at(-1).phase, "disposed");
      }
    }
  }
  assert.deepEqual(web.runs, native.runs, "TS/native observed lifecycle traces");
  return { passed: true, scope: fixture.scope, scenarios: expected.length,
    repeatRuns: 2, phaseSamplesPerRun: expected.reduce((sum, scenario) => sum + scenario.samples.length, 0),
    disposedCpuResources: 0, excluded: fixture.excluded };
}
