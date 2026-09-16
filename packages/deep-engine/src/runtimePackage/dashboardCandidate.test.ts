import { expect, it } from "vitest";
import { DashboardCandidateController } from "./dashboardCandidateController.js";
import { build, draft, rehash, root } from "./dashboardComposition.testUtils.js";
import { fixture, update } from "./dashboardCandidate.testUtils.js";

it("requires a host and never claims a browser render from CPU state", async () => {
  const f = fixture(), controller = new DashboardCandidateController(f.loader);
  expect(await controller.publish(build(), { deviceEpoch: 1 })).toMatchObject({ status: "requires-host" });
  expect(f.loaded).toHaveLength(0);
});
it("consumes all resources before constructing the page, static content and two ChartIR sources", async () => {
  const f = fixture(), source = build();
  expect(await f.controller.publish(source, { deviceEpoch: 1 })).toMatchObject({ status: "committed" });
  expect(f.prepared).toHaveLength(9);
  const page = f.controller.activePage!;
  expect(page).toBe(f.visible());
  expect(page.identity).toMatchObject({ packageHash: source.packageHash.value, generation: 1, deviceEpoch: 1 });
  expect(page.nodes[0]!.deep2d!.atlases.length).toBeGreaterThan(0);
  expect(page.nodes.filter(node => node.chart).map(node => node.chart!.ir.id)).toEqual(["dashboard-chart-a", "dashboard-chart-b"]);
  expect(page.nodes[1]!.effectiveClip).toEqual([20, 180, 420, 300]);
  expect(Object.isFrozen(page.nodes[1]!.chart!.ir.datasets[0]!.rows)).toBe(true);
  f.controller.dispose();
  expect(f.released).toHaveLength(9); expect(new Set(f.released).size).toBe(9);
});
it("keeps frame separate from clipping and switches visible page resources", async () => {
  const f = fixture(), source = draft(), dashboard = root(source);
  dashboard.pages[0]!.nodes[1]!.clip = null; rehash(source);
  await f.controller.publish(source, { deviceEpoch: 1 });
  expect(f.controller.activePage!.nodes[1]!.effectiveClip).toEqual([0, 0, 960, 640]);
  await f.controller.publish(source, { deviceEpoch: 1, pageId: dashboard.pages[1]!.id });
  expect(f.controller.activePage!.identity.pageId).toBe(dashboard.pages[1]!.id);
  expect(f.controller.activePage!.nodes).toHaveLength(1);
  expect(f.released).toHaveLength(9);
});
it("rejects a failing second resource before host preparation and keeps the visible page", async () => {
  const f = fixture(), source = build(); await f.controller.publish(source, { deviceEpoch: 1 });
  const stable = f.controller.activePage, prepare = f.loader.prepare;
  f.loader.prepare = async (item, value, signal) => {
    if (item.resourceId === "dashboard.chart.b") throw new Error("second chart failed");
    return prepare(item, value, signal);
  };
  expect(await f.controller.publish(source, { deviceEpoch: 1 })).toMatchObject({ status: "failed" });
  expect(f.frames).toHaveLength(1); expect(f.visible()).toBe(stable); expect(f.controller.activePage).toBe(stable);
  f.controller.dispose(); expect(new Set(f.released).size).toBe(f.loaded.length);
});
it("does not partially apply the first chart when the second CPU update fails", async () => {
  const f = fixture(), source = build(); await f.controller.publish(source, { deviceEpoch: 1 });
  const stable = f.controller.activePage!, first = update(stable, 0, "replacement"), second = update(stable, 1, "second");
  second.message.expectedDataRevision = 99;
  expect(await f.controller.publish(source, { deviceEpoch: 1, expectedSource: stable.identity, updates: [first, second] })).toMatchObject({ status: "failed" });
  expect(f.visible()).toBe(stable); expect(f.controller.activePage).toBe(stable);
  expect(await f.controller.publish(source, { deviceEpoch: 1, expectedSource: stable.identity, updates: [first] })).toMatchObject({ status: "committed" });
  expect(f.controller.activePage!.nodes[1]!.chart!.ir.datasets[0]!.rows[0]![0]).toBe("replacement");
  expect(f.controller.activePage!.nodes[2]!.chart!.dataRevision).toBe(0);
});
it("forks both simulation clocks so rejected presentation cannot consume their next rows", async () => {
  const f = fixture(), source = build(); await f.controller.publish(source, { deviceEpoch: 1 });
  await f.controller.publish(source, { deviceEpoch: 1, elapsedMs: 0, expectedSource: f.controller.activePage!.identity });
  const stable = f.controller.activePage!, commit = f.host.commitVisible;
  expect(stable.nodes[1]!.chart!.dataRevision).toBe(1);
  f.host.commitVisible = () => { throw new Error("present rejected"); };
  expect(await f.controller.publish(source, { deviceEpoch: 1, expectedSource: stable.identity, elapsedMs: 100 })).toMatchObject({ status: "failed" });
  const rejected = f.frames.at(-1)!;
  expect(f.controller.activePage).toBe(stable); expect(f.visible()).toBe(stable);
  f.host.commitVisible = commit;
  await f.controller.publish(source, { deviceEpoch: 1, expectedSource: stable.identity, elapsedMs: 100 });
  for (const index of [1, 2]) {
    expect(f.controller.activePage!.nodes[index]!.chart).toEqual(rejected.nodes[index]!.chart);
    expect(f.controller.activePage!.nodes[index]!.chart!.dataRevision).toBe(2);
  }
});

it("retains committed CPU chart data and simulation cursors across page switches", async () => {
  const f = fixture(), source = draft(), pages = root(source).pages;
  await f.controller.publish(source, { deviceEpoch: 1 });
  await f.controller.publish(source, { deviceEpoch: 1, elapsedMs: 0, expectedSource: f.controller.activePage!.identity });
  const chart = f.controller.activePage!.nodes[1]!.chart;
  await f.controller.publish(source, { deviceEpoch: 1, pageId: pages[1]!.id });
  await f.controller.publish(source, { deviceEpoch: 1, pageId: pages[0]!.id });
  expect(f.controller.activePage!.nodes[1]!.chart).toEqual(chart);
  await f.controller.publish(source, { deviceEpoch: 1, elapsedMs: 100, expectedSource: f.controller.activePage!.identity });
  expect(f.controller.activePage!.nodes[1]!.chart!.dataRevision).toBe(2);
});

it("rejects stale source events even when package and chart IDs are unchanged", async () => {
  const f = fixture(), source = build(); await f.controller.publish(source, { deviceEpoch: 1 });
  const first = f.controller.activePage!, message = update(first, 0, "old-event");
  await f.controller.publish(source, { deviceEpoch: 1 });
  const stable = f.controller.activePage, allocated = f.loaded.length;
  await expect(f.controller.publish(source, { deviceEpoch: 1, updates: [message] })).rejects.toThrow(/source identity/);
  await expect(f.controller.publish(source, { deviceEpoch: 1, expectedSource: first.identity,
    updates: [message] })).rejects.toThrow(/source identity/);
  await expect(f.controller.publish(source, { deviceEpoch: 1, elapsedMs: 0 })).rejects.toThrow(/source identity/);
  expect(f.loaded).toHaveLength(allocated); expect(f.controller.activePage).toBe(stable);
});
