import { expect, it } from "vitest";
import { draft, rehash, root } from "./dashboardComposition.testUtils.js";
import { fixture, update } from "./dashboardCandidate.testUtils.js";

// Put the real dual-chart fixture on a non-entry page: entry-only tests hide routing failures.
function source() {
  const value = draft(), dashboard = root(value);
  dashboard.entryPageId = dashboard.pages[1]!.id;
  rehash(value);
  return { value, entry: dashboard.entryPageId, charts: dashboard.pages[0]!.id };
}

it("ticks the captured non-entry page and updates its charts independently", async () => {
  const f = fixture(), s = source();
  await f.controller.publish(s.value, { deviceEpoch: 1, pageId: s.charts });
  const original = f.controller.activePage!;
  expect(await f.controller.publish(s.value, { deviceEpoch: 1, expectedSource: original.identity,
    updates: [update(original, 0, "first")] })).toMatchObject({ status: "committed" });
  const first = f.controller.activePage!;
  expect(first.identity.pageId).toBe(s.charts);
  expect(first.nodes[1]!.chart!.dataRevision).toBe(1);
  expect(first.nodes[2]!.chart).toEqual(original.nodes[2]!.chart);
  expect(await f.controller.publish(s.value, { deviceEpoch: 1, expectedSource: first.identity,
    updates: [update(first, 1, "second")] })).toMatchObject({ status: "committed" });
  const second = f.controller.activePage!;
  expect(second.nodes[1]!.chart).toEqual(first.nodes[1]!.chart);
  expect(second.nodes[2]!.chart!.dataRevision).toBe(1);
  expect(await f.controller.publish(s.value, { deviceEpoch: 1,
    expectedSource: second.identity, elapsedMs: 0 })).toMatchObject({ status: "committed" });
  expect(f.controller.activePage!.identity.pageId).toBe(s.charts);
  f.controller.dispose();
});

it("rejects queued source events after switching away and back without allocating", async () => {
  const f = fixture(), s = source();
  await f.controller.publish(s.value, { deviceEpoch: 1, pageId: s.charts });
  const old = f.controller.activePage!;
  await f.controller.publish(s.value, { deviceEpoch: 1, pageId: s.entry });
  const count = f.loaded.length;
  await expect(f.controller.publish(s.value, { deviceEpoch: 1,
    expectedSource: old.identity, updates: [update(old, 0, "stale")] })).rejects.toThrow(/source identity/);
  expect(f.loaded.length).toBe(count);
  await f.controller.publish(s.value, { deviceEpoch: 1, pageId: s.charts });
  const current = f.controller.activePage!, returnedCount = f.loaded.length;
  await expect(f.controller.publish(s.value, { deviceEpoch: 1,
    expectedSource: old.identity, elapsedMs: 0 })).rejects.toThrow(/source identity/);
  expect(f.loaded.length).toBe(returnedCount);
  expect(f.controller.activePage).toBe(current);
  f.controller.dispose();
});

it("preserves the non-entry page and both chart cursors when presentation fails", async () => {
  const f = fixture(), s = source();
  await f.controller.publish(s.value, { deviceEpoch: 1, pageId: s.charts });
  const old = f.controller.activePage!, commit = f.host.commitVisible;
  f.host.commitVisible = () => { throw new Error("present failed"); };
  const options = { deviceEpoch: 1, expectedSource: old.identity, updates: [update(old, 0, "retry")] };
  expect(await f.controller.publish(s.value, options)).toMatchObject({ status: "failed" });
  expect(f.controller.activePage).toBe(old);
  expect(f.visible()).toBe(old);
  f.host.commitVisible = commit;
  expect(await f.controller.publish(s.value, options)).toMatchObject({ status: "committed" });
  expect(f.controller.activePage!.nodes[1]!.chart!.dataRevision).toBe(1);
  expect(f.controller.activePage!.nodes[2]!.chart).toEqual(old.nodes[2]!.chart);
  f.controller.dispose();
});

it("keeps explicit cross-page updates forbidden and fresh publications at the entry page", async () => {
  const f = fixture(), s = source();
  await f.controller.publish(s.value, { deviceEpoch: 1, pageId: s.charts });
  const old = f.controller.activePage!, count = f.loaded.length;
  await expect(f.controller.publish(s.value, { deviceEpoch: 1, pageId: s.entry,
    expectedSource: old.identity, elapsedMs: 0 })).rejects.toThrow(/source identity/);
  expect(f.loaded.length).toBe(count);
  expect(await f.controller.publish(s.value, { deviceEpoch: 1 })).toMatchObject({ status: "committed" });
  expect(f.controller.activePage!.identity.pageId).toBe(s.entry);
  f.controller.dispose();
});
