import { expect, it } from "vitest";
import { buildDashboardCompositionRuntimePackage } from "./dashboardComposition.js";
import { build, input } from "./dashboardComposition.testUtils.js";
import { RuntimeResourcePrewarmExecutor } from "./resourcePrewarmExecutor.js";
import { buildRuntimeResourcePrewarmPlan, buildValidatedRuntimeResourcePrewarmPlan,
  runtimeResourcePrewarmStrategy } from "./resourcePrewarmPlan.js";
import type { RuntimeResourcePrewarmAdapter } from "./resourcePrewarmTypes.js";

function revised(revision = 2) {
  const value = input();
  return buildDashboardCompositionRuntimePackage({ ...value,
    dashboard: { ...value.dashboard, revision, documentRevision: revision } });
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
function fixture(overrides: Partial<RuntimeResourcePrewarmAdapter<string, string>> = {}) {
  const commits: string[] = [], releases: string[] = [];
  const adapter: RuntimeResourcePrewarmAdapter<string, string> = {
    async load(item) { return item.cacheKey; },
    async prepare(_item, loaded) { return loaded; },
    commit(plan) { commits.push(plan.packageHash); },
    release(item) { releases.push(item.cacheKey); }, ...overrides,
  };
  return { executor: new RuntimeResourcePrewarmExecutor(adapter, runtimeResourcePrewarmStrategy), commits, releases };
}
it("plans the real v5 golden once per resource without geometry bake evidence", () => {
  const value = build(), first = buildRuntimeResourcePrewarmPlan(value);
  expect(first).toEqual(buildRuntimeResourcePrewarmPlan(value));
  expect(first.items).toHaveLength(9);
  expect(first.budget.plannedItems).toBe(9);
  expect(first.items.every(item => !Object.hasOwn(item, "bake"))).toBe(true);
  expect(first.items.at(-1)).toMatchObject({ resourceKind: "dashboard-runtime", resourceId: "dashboard.root" });
  expect(new Set(first.items.map(item => item.cacheKey)).size).toBe(9);
  expect(Object.isFrozen(first.items)).toBe(true);
  expect(() => buildValidatedRuntimeResourcePrewarmPlan(value, {}, { cacheKey: "injected", evidence: {} }))
    .toThrow(/cannot include geometry bake/);
});
it("rejects bad hashes and invalid budgets before resource work", async () => {
  const f = fixture(), invalid = structuredClone(build());
  Object.assign(invalid.packageHash, { value: "0".repeat(64) });
  await expect(f.executor.publish(invalid)).rejects.toThrow();
  for (const options of [{ maxItems: 8 }, { maxEstimatedBytes: 1 }, { maxItems: 0 },
    { maxItems: NaN }, { maxEstimatedBytes: Infinity }]) {
    await expect(f.executor.publish(build(), options)).rejects.toThrow();
  }
  expect(f.commits).toEqual([]); expect(f.releases).toEqual([]);
});
it("reuses unchanged content and rechecks stricter budgets across dashboard revisions", async () => {
  const f = fixture(), value = build(), first = await f.executor.publish(value);
  expect(first).toMatchObject({ status: "committed", loadedItems: 9 });
  expect(await f.executor.publish(value)).toMatchObject({ status: "unchanged", loadedItems: 0 });
  const revision = await f.executor.publish(revised());
  expect(revision).toMatchObject({ status: "committed", loadedItems: 1, reusedItems: 8, releasedItems: 1 });
  expect(revision.plan.packageHash).not.toBe(first.plan.packageHash);
  expect(revision.plan.planHash).not.toBe(first.plan.planHash);
  await expect(f.executor.publish(revised(), { maxItems: 8 })).rejects.toThrow(/item budget/);
  expect(f.executor.activePlan).toBe(revision.plan);
  f.executor.dispose(); expect(f.releases).toHaveLength(10);
});
it.each(["prepare", "commit"])("keeps active v5 resources on %s failure", async mode => {
  let failed = false;
  const f = fixture({ async prepare(item, loaded) {
    if (failed && mode === "prepare" && item.type === "resource" && item.resourceKind === "dashboard-runtime") {
      throw new Error("candidate rejected");
    }
    return loaded;
  }, commit() { if (failed && mode === "commit") throw new Error("candidate rejected"); } });
  const stable = await f.executor.publish(build()); failed = true;
  expect(await f.executor.publish(revised())).toMatchObject({ status: "failed", committedItems: 0, releasedItems: 1 });
  expect(f.executor.activePlan).toBe(stable.plan); f.executor.dispose();
});
it.each(["abort", "supersede"])("releases a late v5 resource after %s", async mode => {
  const entered = deferred(), resume = deferred(), slow = revised(2);
  const f = fixture({ async load(item, value) {
    if (value.packageHash.value === slow.packageHash.value) { entered.resolve(); await resume.promise; }
    return item.cacheKey;
  } });
  const stable = await f.executor.publish(build()), controller = new AbortController();
  const pending = f.executor.publish(slow, { signal: controller.signal, concurrency: 1 });
  await entered.promise;
  let expected = stable.plan;
  if (mode === "abort") controller.abort();
  else expected = (await f.executor.publish(revised(3))).plan;
  resume.resolve();
  expect(await pending).toMatchObject({ status: mode === "abort" ? "aborted" : "superseded", committedItems: 0, releasedItems: 1 });
  expect(f.executor.activePlan).toBe(expected);
  expect(f.commits).not.toContain(slow.packageHash.value); f.executor.dispose();
});
