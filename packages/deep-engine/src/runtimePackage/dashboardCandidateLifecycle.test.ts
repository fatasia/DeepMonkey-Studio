import { expect, it } from "vitest";
import { build } from "./dashboardComposition.testUtils.js";
import { deferred, fixture, update } from "./dashboardCandidate.testUtils.js";

it("bounds uncooperative loads to one building candidate even after cancellation", async () => {
  const f = fixture(), source = build(), entered = deferred(), resume = deferred();
  const load = f.loader.load;
  f.loader.load = async (...args) => { entered.resolve(); await resume.promise; return load(...args); };
  const abort = new AbortController();
  const pending = f.controller.publish(source, { deviceEpoch: 1, concurrency: 1, signal: abort.signal });
  await entered.promise; abort.abort();
  for (let index = 0; index < 20; index++) {
    expect(await f.controller.publish(source, { deviceEpoch: 1 })).toMatchObject({ status: "busy" });
  }
  expect(f.loaded).toHaveLength(0); expect(f.released).toHaveLength(0);
  resume.resolve();
  expect(await pending).toMatchObject({ status: "aborted" });
  expect(f.loaded).toHaveLength(1); expect(f.released).toHaveLength(1);
  expect(f.frames).toHaveLength(0);
  f.loader.load = load;
  expect((await f.controller.publish(source, { deviceEpoch: 1 })).status).toBe("committed");
});

it.each(["abort", "epoch", "dispose"])("reclaims late host preparation after %s without a visible commit", async mode => {
  const f = fixture(), source = build(); await f.controller.publish(source, { deviceEpoch: 1 });
  const stable = f.controller.activePage, entered = deferred(), resume = deferred(), prepare = f.host.prepare;
  f.host.prepare = async (...args) => { const result = await prepare(...args); entered.resolve(); await resume.promise; return result; };
  const abort = new AbortController();
  const pending = f.controller.publish(source, { deviceEpoch: 1, signal: abort.signal });
  await entered.promise;
  expect(f.visible()).toBe(stable);
  if (mode === "abort") abort.abort();
  else if (mode === "epoch") f.setEpoch(2);
  else f.controller.dispose();
  expect(f.releasedFrames).toHaveLength(mode === "dispose" ? 1 : 0);
  resume.resolve();
  expect((await pending).status).toBe(mode === "abort" ? "aborted" : mode === "epoch" ? "device-changed" : "superseded");
  expect(f.visible()).toBe(stable);
  expect(f.controller.activePage).toBe(mode === "dispose" ? undefined : stable);
  expect(f.releasedFrames).toHaveLength(mode === "dispose" ? 2 : 1);
  f.controller.dispose(); expect(new Set(f.released).size).toBe(18); expect(f.released).toHaveLength(18);
});

it("rejects a wrong epoch before allocating resources and handles an unavailable device", async () => {
  const f = fixture();
  expect((await f.controller.publish(build(), { deviceEpoch: 2 })).status).toBe("device-changed");
  f.host.currentDeviceEpoch = () => { throw new Error("device lost"); };
  expect((await f.controller.publish(build(), { deviceEpoch: 1 })).status).toBe("device-changed");
  expect(f.loaded).toHaveLength(0);
});

it("rejects visible-commit reentrancy and leaves no disposed-but-active state", async () => {
  const f = fixture(), source = build(), commit = f.host.commitVisible;
  let nested: Promise<unknown> | undefined;
  f.host.commitVisible = frame => {
    expect(() => f.controller.dispose()).toThrow(/reentrancy/);
    nested = f.controller.publish(source, { deviceEpoch: 1 }).catch(error => error);
    commit(frame);
  };
  expect((await f.controller.publish(source, { deviceEpoch: 1 })).status).toBe("committed");
  expect(await nested).toBeInstanceOf(Error);
  f.controller.dispose();
  expect(f.controller.activePage).toBeUndefined(); expect(f.released).toHaveLength(9);
});

it("preserves the old candidate when host preparation rejects and reports every cleanup failure", async () => {
  const f = fixture(), source = build(); await f.controller.publish(source, { deviceEpoch: 1 });
  const stable = f.controller.activePage, release = f.loader.release;
  f.host.prepare = async () => { throw new Error("offscreen prepare failed"); };
  f.loader.release = (...args) => { release(...args); throw new Error("resource release failed"); };
  const result = await f.controller.publish(source, { deviceEpoch: 1 });
  expect(result).toMatchObject({ status: "failed", failure: "offscreen prepare failed" });
  expect(result.releaseFailures).toHaveLength(9);
  expect(f.released).toHaveLength(9); expect(f.controller.activePage).toBe(stable); expect(f.visible()).toBe(stable);
});

it("holds the full resource barrier and snapshots events before an asynchronous load", async () => {
  const f = fixture(), source = build(); await f.controller.publish(source, { deviceEpoch: 1 });
  const stable = f.controller.activePage!, mutation = update(stable, 0, "accepted-event");
  const entered = deferred(), resume = deferred(), prepare = f.loader.prepare;
  f.loader.prepare = async (item, value, signal) => {
    if (item.resourceId === "dashboard.chart.b") { entered.resolve(); await resume.promise; }
    return prepare(item, value, signal);
  };
  const pending = f.controller.publish(source, { deviceEpoch: 1,
    expectedSource: stable.identity, updates: [mutation] });
  await entered.promise;
  mutation.message.datasets[0]!.rows[0]![0] = "mutated-after-request";
  expect(f.frames).toHaveLength(1); expect(f.controller.activePage).toBe(stable);
  resume.resolve(); expect((await pending).status).toBe("committed");
  expect(f.controller.activePage!.nodes[1]!.chart!.ir.datasets[0]!.rows[0]![0]).toBe("accepted-event");
});

it("keeps exactly one visible frame while successive packages replace it", async () => {
  const f = fixture();
  const first = await f.controller.publish(build(), { deviceEpoch: 1 });
  expect(first).toMatchObject({ status: "committed" });
  const pageA = f.controller.activePage!;
  // 数据更新产生不同 packageHash:换包必须清掉同包页状态缓存并替换可见帧。
  const mutation = update(pageA, 0, "successive");
  expect((await f.controller.publish(build(), { deviceEpoch: 1,
    expectedSource: pageA.identity, updates: [mutation] })).status).toBe("committed");
  const pageB = f.controller.activePage!;
  expect(pageB).not.toBe(pageA); expect(f.visible()).toBe(pageB);
  expect(f.releasedFrames).toEqual([pageA]);
  // 同 hash 重发布(后台刷新轨迹):页状态缓存保留,可见帧仍被新帧替换。
  expect((await f.controller.publish(build(), { deviceEpoch: 1 })).status).toBe("committed");
  const pageC = f.controller.activePage!;
  expect(pageC).not.toBe(pageB); expect(f.visible()).toBe(pageC);
  expect(f.releasedFrames).toEqual([pageA, pageB]);
  expect(f.controller.activePage!.identity.packageHash).toBe(pageB.identity.packageHash);
  f.controller.dispose();
  expect(f.releasedFrames).toHaveLength(3); expect(new Set(f.released).size).toBe(27);
});

it("fails closed on bad resources both without and with an active candidate", async () => {
  const load = fixture();
  load.loader.load = async () => { throw new Error("corrupt resource bytes"); };
  expect(await load.controller.publish(build(), { deviceEpoch: 1 }))
    .toMatchObject({ status: "failed", failure: "corrupt resource bytes", releaseFailures: [] });
  expect(load.loaded).toEqual([]); expect(load.released).toEqual([]);
  expect(load.frames).toHaveLength(0); expect(load.controller.activePage).toBeUndefined();

  const f = fixture(), source = build(); await f.controller.publish(source, { deviceEpoch: 1 });
  const stable = f.controller.activePage, prepare = f.loader.prepare;
  f.loader.prepare = async (item, value, signal) => {
    if (item.resourceId === "dashboard.chart.b") throw new Error("bad chart payload");
    return prepare(item, value, signal);
  };
  const result = await f.controller.publish(source, { deviceEpoch: 1 });
  expect(result).toMatchObject({ status: "failed", failure: "bad chart payload" });
  expect(f.controller.activePage).toBe(stable); expect(f.visible()).toBe(stable);
  expect(f.frames).toHaveLength(1); expect(f.releasedFrames).toHaveLength(0);
  // 释放计数 17 = 稳定候选 9 + 失败候选 8:prepare 抛错的 chart.b 从未完成预备,按既有
  // executor 语义不进入 release 清单(与 loader.load 的对象归属一致),不是泄漏。
  f.controller.dispose(); expect(new Set(f.released).size).toBe(17);
});
