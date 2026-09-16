import { expect, it } from "vitest";
import { build, input } from "./dashboardComposition.testUtils.js";
import { buildDashboardCompositionRuntimePackage } from "./dashboardComposition.js";
import { RuntimeResourcePrewarmExecutor } from "./resourcePrewarmExecutor.js";
import { runtimeResourcePrewarmStrategy } from "./resourcePrewarmPlan.js";
import type { RuntimeResourcePrewarmAdapter } from "./resourcePrewarmTypes.js";

function revised(revision: number) {
  const source = input();
  return buildDashboardCompositionRuntimePackage({ ...source,
    dashboard: { ...source.dashboard, revision, documentRevision: revision } });
}
function fixture() {
  const released: object[] = [], commits: string[] = [];
  let callback = () => {};
  const adapter: RuntimeResourcePrewarmAdapter<object, object> = {
    async load() { return {}; }, async prepare(_item, loaded) { return loaded; },
    commit(plan) { callback(); commits.push(plan.packageHash); },
    release(_item, loaded) { released.push(loaded); },
  };
  const executor = new RuntimeResourcePrewarmExecutor(adapter, runtimeResourcePrewarmStrategy);
  return { executor, released, commits, onCommit(value: () => void) { callback = value; } };
}

it("rejects dispose inside commit without disposing resources or resurrecting disposed state", async () => {
  const f = fixture();
  await f.executor.publish(build());
  f.onCommit(() => {
    expect(() => f.executor.dispose()).toThrow(/commit.*reentr/i);
    expect(f.released).toHaveLength(0);
  });
  const next = await f.executor.publish(revised(2));
  expect(next.status).toBe("committed");
  expect(f.executor.activePlan).toBe(next.plan);
  expect(f.released).toHaveLength(1);
  f.executor.dispose(); f.executor.dispose();
  expect(f.executor.activePlan).toBeUndefined();
  expect(f.released).toHaveLength(10);
  expect(new Set(f.released).size).toBe(10);
});

it("rejects publish inside commit before it can capture prior resource handles", async () => {
  const f = fixture();
  await f.executor.publish(build());
  let nested: Promise<unknown> | undefined;
  f.onCommit(() => { nested = f.executor.publish(revised(3)).catch(error => error); });
  const next = await f.executor.publish(revised(2));
  expect(next.status).toBe("committed");
  expect(await nested).toBeInstanceOf(Error);
  expect(String(await nested)).toMatch(/commit.*reentr/i);
  expect(f.commits).toHaveLength(2);
  expect(f.executor.activePlan).toBe(next.plan);
  f.onCommit(() => {});
  expect(await f.executor.publish(revised(3))).toMatchObject({ status: "committed", loadedItems: 1, reusedItems: 8 });
  f.executor.dispose();
  expect(f.released).toHaveLength(11);
  expect(new Set(f.released).size).toBe(11);
});

it("retains the active candidate on uncaught commit reentrancy and unlocks future work", async () => {
  const f = fixture(), stable = await f.executor.publish(build());
  f.onCommit(() => { f.executor.dispose(); });
  expect(await f.executor.publish(revised(2))).toMatchObject({ status: "failed", committedItems: 0, releasedItems: 1 });
  expect(f.executor.activePlan).toBe(stable.plan);
  expect(f.commits).toHaveLength(1);
  f.onCommit(() => {});
  expect((await f.executor.publish(revised(3))).status).toBe("committed");
  f.executor.dispose();
  expect(f.released).toHaveLength(11);
  expect(new Set(f.released).size).toBe(11);
});
