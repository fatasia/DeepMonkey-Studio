import { describe, expect, it } from "vitest";
import { DEFAULT_SHADOW_PAGE_TILE, ShadowPageTable, buildShadowPageRequests,
  facesForKind, pageId, shadowPageCostBytes } from "./shadowPages.js";

const spec = DEFAULT_SHADOW_PAGE_TILE;
const light = (key: string, importance: number, mipLevels: number, kind: "point" | "spot" = "point") =>
  ({ key, kind, importance, mipLevels });

describe("virtual shadow page requests", () => {
  it("expands mip-prefixed pages per face and prices mips at a quarter each", () => {
    expect(facesForKind("point")).toHaveLength(6);
    expect(facesForKind("spot")).toEqual([undefined]);
    expect(shadowPageCostBytes(spec, 0)).toBe(256 * 256 * 4);
    expect(shadowPageCostBytes(spec, 2)).toBe(64 * 64 * 4);
    const requests = buildShadowPageRequests([light("lamp", 4, 2, "point"), light("torch", 1, 1, "spot")]);
    expect(requests).toHaveLength(12 + 1);
    expect(requests.map(request => request.id).filter(id => id.startsWith("lamp|+x|"))).toEqual(["lamp|+x|mip0", "lamp|+x|mip1"]);
    expect(requests.every(request => request.costBytes > 0)).toBe(true);
  });

  it("rejects malformed lights and duplicate expansion", () => {
    expect(() => buildShadowPageRequests([light("a|b", 1, 1)])).toThrow("'|'");
    expect(() => buildShadowPageRequests([light("a", -1, 1)])).toThrow("importance");
    expect(() => buildShadowPageRequests([light("a", 1, 0)])).toThrow("mipLevels");
    expect(() => buildShadowPageRequests([{ key: "a", kind: "cube" as never, importance: 1, mipLevels: 1 }])).toThrow("kind");
    expect(() => buildShadowPageRequests([light("a", 1, 1)], { tileEdgeTexels: 300, depthBytesPerTexel: 4 })).toThrow("power-of-two");
  });
});

describe("ShadowPageTable residency semantics", () => {
  it("admits low mips before high mips and keeps the chain a prefix", () => {
    const budget = shadowPageCostBytes(spec, 0) + shadowPageCostBytes(spec, 1);
    const table = new ShadowPageTable(spec, { maxBytes: budget });
    const plan = table.plan(buildShadowPageRequests([light("a", 1, 3, "spot")]), 0);
    expect(plan.stats.admittedCount).toBe(2);
    expect(plan.resident.map(page => page.mip).sort()).toEqual([0, 1]);
    expect(plan.deferred.map(page => page.id)).toEqual(["a|spot|mip2"]);
    // A page whose mip prefix is not resident can never be admitted, even alone in budget.
    const lone = new ShadowPageTable(spec, { maxBytes: shadowPageCostBytes(spec, 0) * 8 });
    const orphan = [{ id: pageId("b", undefined, 1), lightKey: "b", face: undefined, mip: 1,
      importance: 1, costBytes: shadowPageCostBytes(spec, 1) } as const];
    const split = lone.plan(orphan, 0);
    expect(split.admitted).toHaveLength(0);
    expect(split.deferred.map(page => page.id)).toEqual(["b|spot|mip1"]);
    expect(split.stats.residentBytes).toBe(0);
  });

  it("prefers higher importance lights when the budget must choose", () => {
    const onePage = shadowPageCostBytes(spec, 0);
    const table = new ShadowPageTable(spec, { maxBytes: onePage });
    const requests = buildShadowPageRequests([light("weak", 1, 1, "spot"), light("strong", 9, 1, "spot")]);
    const plan = table.plan(requests, 0);
    expect(plan.resident.map(page => page.lightKey)).toEqual(["strong"]);
    expect(plan.stats.lightsWithPages).toBe(1);
    expect(plan.stats.lightsDeferred).toBe(1);
  });

  it("enforces the byte budget as a hard invariant every frame", () => {
    const onePage = shadowPageCostBytes(spec, 0);
    const table = new ShadowPageTable(spec, { maxBytes: onePage * 3 });
    for (let frame = 0; frame < 4; frame++) {
      const requests = buildShadowPageRequests([light(`l${frame}`, 5 - frame, 1), light("anchor", 10, 1)]);
      const plan = table.plan(requests, frame);
      expect(plan.stats.residentBytes).toBeLessThanOrEqual(onePage * 3);
      expect(plan.stats.residentCount).toBeLessThanOrEqual(3);
      expect(plan.stats.residentBytes).toBe(table.residentByteCount);
    }
  });

  it("reuses resident pages on frozen scenes without re-admitting or evicting", () => {
    const table = new ShadowPageTable(spec, { maxBytes: 1 << 30 });
    const requests = buildShadowPageRequests([light("a", 2, 1, "spot"), light("b", 3, 1, "spot")]);
    const first = table.plan(requests, 0);
    expect(first.stats.admittedCount).toBe(2);
    for (let frame = 1; frame <= 3; frame++) {
      const plan = table.plan(requests, frame);
      expect(plan.admitted).toHaveLength(0);
      expect(plan.evicted).toHaveLength(0);
      expect(plan.deferred).toHaveLength(0);
      expect(plan.stats.requestCount).toBe(requests.length);
      expect(plan.resident.map(page => page.id).sort()).toEqual(first.resident.map(page => page.id).sort());
    }
  });

  it("evicts least-recently-used unrequested pages first under pressure and honors maxPages", () => {
    const onePage = shadowPageCostBytes(spec, 0);
    const table = new ShadowPageTable(spec, { maxBytes: onePage * 2, maxPages: 2 });
    table.plan(buildShadowPageRequests([light("a", 1, 1, "spot"), light("b", 1, 1, "spot")]), 0);
    // Frame 1 requests a and a new light c: b is the only unrequested page, so LRU picks b.
    const plan = table.plan(buildShadowPageRequests([light("a", 1, 1, "spot"), light("c", 1, 1, "spot")]), 1);
    expect(plan.evicted.map(page => page.lightKey)).toEqual(["b"]);
    expect(plan.admitted.map(page => page.lightKey)).toEqual(["c"]);
    expect(plan.resident.map(page => page.lightKey).sort()).toEqual(["a", "c"]);
    expect(table.residentCount).toBe(2);
    // Same-frame requested pages are protected: with a full live set the newcomer defers.
    const held = table.plan(buildShadowPageRequests([light("a", 1, 1, "spot"), light("c", 1, 1, "spot"),
      light("d", 1, 1, "spot")]), 2);
    expect(held.evicted).toHaveLength(0);
    expect(held.deferred.map(page => page.lightKey)).toEqual(["d"]);
  });

  it("drops removed lights within one frame so no stale shadow survives", () => {
    const table = new ShadowPageTable(spec, { maxBytes: 1 << 30 });
    table.plan(buildShadowPageRequests([light("gone", 5, 1, "spot"), light("kept", 5, 1, "spot")]), 0);
    const plan = table.plan(buildShadowPageRequests([light("kept", 5, 1, "spot")]), 1);
    expect(plan.evicted.map(page => page.lightKey)).toEqual(["gone"]);
    expect(plan.resident.some(page => page.lightKey === "gone")).toBe(false);
  });

  it("raises a light's mip chain in place and demotes only the freed pages", () => {
    const table = new ShadowPageTable(spec, { maxBytes: 1 << 30 });
    table.plan(buildShadowPageRequests([light("a", 1, 1, "spot")]), 0);
    const richer = table.plan(buildShadowPageRequests([light("a", 2, 2, "spot")]), 1);
    expect(richer.admitted.map(page => page.mip)).toEqual([1]);
    expect(richer.evicted).toHaveLength(0);
    const poorer = table.plan(buildShadowPageRequests([light("a", 1, 1, "spot")]), 2);
    expect(poorer.evicted.map(page => page.mip)).toEqual([1]);
    expect(poorer.admitted).toHaveLength(0);
  });

  it("rejects invalid frames, duplicate ids and mismatched ids", () => {
    const table = new ShadowPageTable(spec, { maxBytes: 1024 });
    const requests = buildShadowPageRequests([light("a", 1, 1, "spot")]);
    expect(() => table.plan(requests, -1)).toThrow("Frame");
    expect(() => table.plan([...requests, ...requests], 0)).toThrow("Duplicate");
    const broken = [{ ...requests[0]!, id: pageId("b", undefined, 0) }];
    expect(() => table.plan(broken, 0)).toThrow("must match");
    expect(() => new ShadowPageTable(spec, { maxBytes: 0 })).toThrow("maxBytes");
    expect(() => new ShadowPageTable(spec, { maxBytes: 1024, maxPages: 0 })).toThrow("maxPages");
  });
});

describe("ShadowPageTable eviction prefix cascade", () => {
  it("cascades the whole mip chain when evicting a low mip under pressure", () => {
    const chain = shadowPageCostBytes(spec, 0) + shadowPageCostBytes(spec, 1);
    const table = new ShadowPageTable(spec, { maxBytes: chain });
    // 驻留 a 的 mip0+mip1(同帧引入,LRU/importance/id 三键全同,旧逻辑会先逐 id 最小的 mip0)。
    table.plan(buildShadowPageRequests([light("a", 1, 2, "spot")]), 0);
    expect(table.residentByteCount).toBe(chain);
    // 新灯 c 挤预算:a 的 mip0 未再请求且为驱逐候选 → 必须整链级联,不得残留 mip1。
    const r1 = table.plan(buildShadowPageRequests([light("c", 2, 2, "spot")]), 1);
    const residentMips = r1.resident.filter((page) => page.lightKey === "a").map((page) => page.mip);
    expect(residentMips).toEqual([]);
    expect(r1.evicted.map((page) => page.id).sort()).toEqual(["a|spot|mip0", "a|spot|mip1"]);
  });
});
