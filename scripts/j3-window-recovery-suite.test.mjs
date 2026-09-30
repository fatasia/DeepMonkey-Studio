import test from "node:test";
import assert from "node:assert/strict";
import { executeWindowRecoverySuite, freshWindowEnvironment, snapshotWindowRecoverySources, WINDOW_RECOVERY_COMPONENTS } from "./j3-window-recovery-suite.mjs";

function setup() {
  const calls = [], removed = [], published = [];
  const sources = { "packages/deep-engine/src/core.ts": "frozen-source" };
  const window = { passed: true, stable: true, currentRun: true, sources, web: [{}, {}], native: [{}, {}], execution: { native: "fresh-two-child-processes" } };
  const web = { passed: true, stable: true, currentRun: true, sources, web: [{ actualUnknownDriverFault: false }, { actualUnknownDriverFault: false }] };
  const fixtures = Object.fromEntries(WINDOW_RECOVERY_COMPONENTS.map(component => [component.evidence,
    structuredClone(component.id === "actual-window" ? window : web)]));
  return { calls, removed, published, fixtures, options: {
    removeEvidence: async file => { removed.push(file); },
    runScript: async script => { calls.push(script); assert.equal(removed.length, 4); },
    readEvidence: async file => fixtures[file], publishEvidence: async evidence => { published.push(evidence); },
    snapshotSources: async () => ({ sha256: "frozen-product-sources", sources }),
  } };
}

test("fresh window once, then Web-only candidates; no duplicate Native command", async () => {
  const f = setup(), evidence = await executeWindowRecoverySuite(f.options);
  assert.deepEqual(f.calls, WINDOW_RECOVERY_COMPONENTS.map(component => component.script));
  assert.equal(f.calls.filter(script => script === "scripts/j3-window-recovery-parity.mjs").length, 1);
  assert(f.calls.every(script => !script.includes("--web-only") && !script.includes("cargo")));
  assert.equal(evidence.currentRun, true); assert.equal(evidence.pairedWindow.native.length, 2);
  assert.equal(evidence.webOnlyChecks.success.web[0].actualUnknownDriverFault, false);
  assert.equal(f.published.length, 1);
});

for (const component of WINDOW_RECOVERY_COMPONENTS) {
  test(`${component.id} nonzero command propagates and clears passing suite`, async () => {
    const f = setup(); f.options.runScript = async script => { f.calls.push(script); if (script === component.script) throw new Error("child exit 1"); };
    await assert.rejects(executeWindowRecoverySuite(f.options), /child exit 1/); assert.equal(f.published.length, 0);
    assert.equal(f.calls.at(-1), component.script); assert.equal(f.removed.at(-1), f.removed[0]);
  });
  for (const field of ["passed", "stable", "currentRun"]) {
    test(`${component.id} rejects ${field}=false before publishing suite`, async () => {
      const f = setup(); f.fixtures[component.evidence][field] = false;
      await assert.rejects(executeWindowRecoverySuite(f.options)); assert.equal(f.published.length, 0);
    });
  }
}
test("a prior Native receipt cannot be promoted to currentRun", async () => {
  const f = setup(); f.fixtures[WINDOW_RECOVERY_COMPONENTS[0].evidence].execution.native = "prior-explicit-receipts";
  await assert.rejects(executeWindowRecoverySuite(f.options)); assert.equal(f.published.length, 0);
});
test("missing fresh second Web instance fails", async () => {
  const f = setup(); f.fixtures[WINDOW_RECOVERY_COMPONENTS[1].evidence].web.pop();
  await assert.rejects(executeWindowRecoverySuite(f.options), /two fresh Web/); assert.equal(f.published.length, 0);
});
test("candidate simulation cannot be relabeled an actual unknown driver fault", async () => {
  const f = setup(); f.fixtures[WINDOW_RECOVERY_COMPONENTS[2].evidence].web[0].actualUnknownDriverFault = true;
  await assert.rejects(executeWindowRecoverySuite(f.options), /explicitly synthetic/); assert.equal(f.published.length, 0);
});
test("product source changes invalidate the combined fresh evidence", async () => {
  const f = setup(); let count = 0;
  f.options.snapshotSources = async () => ({ sha256: String(count++), sources: { "packages/deep-engine/src/core.ts": "frozen-source" } });
  await assert.rejects(executeWindowRecoverySuite(f.options), /sources changed/);
  assert.equal(f.published.length, 0); assert.equal(f.removed.at(-1), f.removed[0]);
});
test("child environment strips parent-only selection/output variables and keeps required runtime configuration", () => {
  const env = { DEEP_WINDOW_LOSS_CHILD: "1", J3_WINDOW_NATIVE_OUTPUT: "prior-path", BIM_STUDIO_CHROME_PATH: "chrome", PATH: "runtime-path" };
  assert.deepEqual(freshWindowEnvironment(env), { BIM_STUDIO_CHROME_PATH: "chrome", PATH: "runtime-path" });
  assert.equal(env.DEEP_WINDOW_LOSS_CHILD, "1");
});
test("a child's stale or absent source identity cannot enter the passing suite", async () => {
  const f = setup(); f.fixtures[WINDOW_RECOVERY_COMPONENTS[1].evidence].sources["packages/deep-engine/src/core.ts"] = "old-source";
  await assert.rejects(executeWindowRecoverySuite(f.options), /child source differs/); assert.equal(f.published.length, 0);
  const absent = setup(); delete absent.fixtures[WINDOW_RECOVERY_COMPONENTS[2].evidence].sources;
  await assert.rejects(executeWindowRecoverySuite(absent.options), /child source identity required/); assert.equal(absent.published.length, 0);
});
test("the complete product identity includes Native production shader assets and the actual window package", async () => {
  const identity = await snapshotWindowRecoverySources();
  assert.match(identity.sources["packages/deep-engine-native/assets/shaders/native_mesh_v1.wgsl"], /^[0-9a-f]{64}$/);
  assert.match(identity.sources["packages/deep-engine-native/tests/fixtures/runtime-package-author-lod-v1.json"], /^[0-9a-f]{64}$/);
});
