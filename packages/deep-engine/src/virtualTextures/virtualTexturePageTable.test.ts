import { describe, expect, it } from "vitest";
import { buildVirtualTexturePageRequests, VirtualTexturePageTable,
  type VirtualTextureFootprint, type VirtualTexturePageRequest } from "./virtualTexturePageTable.js";
import { virtualTexturePageCostBytes, virtualTexturePageId } from "./virtualTexturePages.js";

const TILE = Object.freeze({ tileEdgeTexels: 4, bytesPerTexel: 4 });
const COST = virtualTexturePageCostBytes(TILE, 0);
const MIP1 = virtualTexturePageCostBytes(TILE, 1);

function footprint(overrides: Partial<VirtualTextureFootprint> = {}): VirtualTextureFootprint {
  return { textureId: "tex", tileX: 0, tileY: 0, maxMip: 1, weight: 1, ...overrides };
}

function requestsFor(footprints: readonly VirtualTextureFootprint[]): readonly VirtualTexturePageRequest[] {
  return buildVirtualTexturePageRequests(footprints, TILE);
}

function plan(table: VirtualTexturePageTable, footprints: readonly VirtualTextureFootprint[], frame: number) {
  return table.plan(requestsFor(footprints), frame);
}

function commitPlan(table: VirtualTexturePageTable,
  result: ReturnType<VirtualTexturePageTable["plan"]>): void {
  table.commitAdmissions(result.admitted.map(page => page.id));
}

describe("virtual texture page request builder", () => {
  it("expands mip prefixes, dedups by id with the max weight, and sorts deterministically", () => {
    const requests = requestsFor([footprint({ tileX: 1, maxMip: 2, weight: 5 }),
      footprint({ tileX: 1, maxMip: 0, weight: 9 }), footprint({ tileX: 0, maxMip: 0, weight: 2 })]);
    expect(requests.map(request => request.id)).toEqual([
      virtualTexturePageId("tex", 0, 0, 0), virtualTexturePageId("tex", 1, 0, 0),
      virtualTexturePageId("tex", 1, 0, 1), virtualTexturePageId("tex", 1, 0, 2)]);
    expect(requests.find(request => request.id === virtualTexturePageId("tex", 1, 0, 0))!.weight).toBe(9);
    expect(requests.every(request => request.costBytes === virtualTexturePageCostBytes(TILE, request.mip))).toBe(true);
  });

  it("rejects malformed footprints and specs", () => {
    expect(() => requestsFor([footprint({ textureId: "a|b" })])).toThrow(/\|/);
    expect(() => requestsFor([footprint({ textureId: "" })])).toThrow();
    expect(() => requestsFor([footprint({ tileX: -1 })])).toThrow(/tile coordinates/);
    expect(() => requestsFor([footprint({ maxMip: 16 })])).toThrow(/maxMip/);
    expect(() => requestsFor([footprint({ weight: -1 })])).toThrow(/weight/);
    expect(() => requestsFor([footprint({ weight: Number.NaN })])).toThrow(/weight/);
    expect(() => buildVirtualTexturePageRequests([footprint()], { tileEdgeTexels: 3, bytesPerTexel: 4 }))
      .toThrow(/spec is invalid/);
  });
});

describe("virtual texture page table residency", () => {
  it("keeps the byte budget a hard invariant and prefers low mips then weight", () => {
    const table = new VirtualTexturePageTable(TILE, { maxBytes: COST * 2 });
    const planZero = plan(table, [footprint({ tileX: 0, maxMip: 2, weight: 5 }),
      footprint({ tileX: 1, maxMip: 2, weight: 9 })], 0);
    // Budget fits the two mip0 anchors (low mip first, heavier tile first); deeper mips defer.
    expect(planZero.admitted.map(page => page.id)).toEqual([
      virtualTexturePageId("tex", 1, 0, 0), virtualTexturePageId("tex", 0, 0, 0)]);
    expect(planZero.stats.residentBytes).toBe(COST * 2);
    expect(planZero.stats.deferredCount).toBe(4);
    expect(planZero.stats.budgetUtilization).toBe(1);
  });

  it("defers deeper mips when the chain prefix is missing and protects requested pages", () => {
    const table = new VirtualTexturePageTable(TILE, { maxBytes: COST * 4 });
    const first = plan(table, [footprint({ tileX: 0, maxMip: 1, weight: 1 })], 0);
    expect(first.stats.admittedCount).toBe(2);
    table.commitAdmissions(first.admitted.map(page => page.id));
    // Same-frame requests are never evicted: a full window must defer, not evict the warm set.
    const second = plan(table, [footprint({ tileX: 0, maxMip: 1, weight: 1 }),
      footprint({ tileX: 1, maxMip: 1, weight: 1 }), footprint({ tileX: 2, maxMip: 1, weight: 1 }),
      footprint({ tileX: 3, maxMip: 1, weight: 1 })], 1);
    expect(second.stats.evictedCount).toBe(0);
    // Three full chains settle; tile 3's mip0 misses by budget and its mip1 by the prefix.
    expect(second.stats.deferredCount).toBe(2);
    expect(second.stats.residentBytes).toBe(3 * (COST + MIP1));
  });

  it("evicts by LRU under pressure and honors dwell protection", () => {
    const lru = new VirtualTexturePageTable(TILE, { maxBytes: COST * 2 });
    commitPlan(lru, plan(lru, [footprint({ tileX: 0, maxMip: 0, weight: 1 })], 0));
    commitPlan(lru, plan(lru, [footprint({ tileX: 1, maxMip: 0, weight: 1 })], 1));
    const pressured = plan(lru, [footprint({ tileX: 2, maxMip: 0, weight: 1 })], 2);
    // Tile 0 is the least recently used committed page, so it must yield first.
    expect(pressured.evicted.map(page => page.id)).toEqual([virtualTexturePageId("tex", 0, 0, 0)]);
    expect(pressured.stats.residentBytes).toBe(COST * 2);

    const dwell = new VirtualTexturePageTable(TILE, { maxBytes: COST * 2, minResidentFrames: 3 });
    commitPlan(dwell, plan(dwell, [footprint({ tileX: 0, maxMip: 0, weight: 1 })], 0));
    commitPlan(dwell, plan(dwell, [footprint({ tileX: 1, maxMip: 0, weight: 1 })], 1));
    const blocked = plan(dwell, [footprint({ tileX: 2, maxMip: 0, weight: 1 })], 2);
    // Young pages are dwell-protected: the newcomer defers instead of breaking the guarantee.
    expect(blocked.stats.admittedCount).toBe(0);
    expect(blocked.stats.deferredCount).toBe(1);
    const settled = plan(dwell, [footprint({ tileX: 2, maxMip: 0, weight: 1 })], 3);
    expect(settled.evicted.map(page => page.id)).toEqual([virtualTexturePageId("tex", 0, 0, 0)]);
    expect(settled.stats.admittedCount).toBe(1);
    dwell.setDwellFrames(0);
    expect(dwell.dwellFrames).toBe(0);
    expect(() => dwell.setDwellFrames(-1)).toThrow(/dwell/);

    // Evicting an anchor mip cascades to the chain suffix so the prefix invariant survives.
    const cascade = new VirtualTexturePageTable(TILE, { maxBytes: COST * 2 });
    commitPlan(cascade, plan(cascade, [footprint({ tileX: 0, maxMip: 1, weight: 1 })], 0));
    const evictedChain = plan(cascade, [footprint({ tileX: 1, maxMip: 1, weight: 1 })], 1);
    expect(evictedChain.evicted.map(page => page.id)).toEqual([
      virtualTexturePageId("tex", 0, 0, 0), virtualTexturePageId("tex", 0, 0, 1)]);
    expect(evictedChain.admitted.length).toBe(2);
    expect(cascade.residentMipDepth("tex", 0, 0)).toBe(-1);
  });

  it("reports committed chain depth for legal low-mip fallback (in-flight pages are not sampleable)", () => {
    const table = new VirtualTexturePageTable(TILE, { maxBytes: COST * 3 });
    const upload = plan(table, [footprint({ tileX: 0, maxMip: 2, weight: 3 })], 0);
    expect(table.residentMipDepth("tex", 0, 0)).toBe(-1);
    table.commitAdmissions(upload.admitted.map(page => page.id));
    expect(table.residentMipDepth("tex", 0, 0)).toBe(2);
    expect(table.residentMipDepth("tex", 9, 9)).toBe(-1);
  });

  it("rejects duplicate, malformed and cost-mismatched requests", () => {
    const table = new VirtualTexturePageTable(TILE, { maxBytes: COST });
    const good = requestsFor([footprint()]);
    expect(() => table.plan([...good, ...good], 0)).toThrow(/Duplicate/);
    expect(() => table.plan([virtualTexturePageId("tex", 0, 0, 0) as never], 0)).toThrow();
    const wrongCost = { ...good[0]!, costBytes: COST + 1 };
    expect(() => table.plan([wrongCost], 0)).toThrow(/does not match/);
    expect(() => table.plan(good, -1)).toThrow(/Frame index/);
  });
});

describe("virtual texture cancellation and release consistency", () => {
  it("rolls back cancelled uploads without leaking in-flight references", () => {
    const table = new VirtualTexturePageTable(TILE, { maxBytes: COST * 4 });
    const upload = plan(table, [footprint({ tileX: 0, maxMip: 1 }), footprint({ tileX: 1, maxMip: 1 })], 0);
    expect(table.inflightCount).toBe(4);
    // Cancel the mip1 pair, commit the mip0 pair.
    const cancelled = upload.admitted.filter(page => page.mip === 1).map(page => page.id);
    const committed = upload.admitted.filter(page => page.mip === 0).map(page => page.id);
    table.rollbackAdmissions(cancelled);
    table.commitAdmissions(committed);
    expect(table.inflightCount).toBe(0);
    expect(table.rolledBackCount).toBe(2);
    expect(table.residentCount).toBe(2);
    expect(table.residentByteCount).toBe(COST * 2);
    expect(table.residentMipDepth("tex", 0, 0)).toBe(0);
    // Rolled-back pages leave no residue: the next frame re-requests them cleanly.
    const retry = plan(table, [footprint({ tileX: 0, maxMip: 1 }), footprint({ tileX: 1, maxMip: 1 })], 1);
    expect(retry.admitted.map(page => page.mip)).toEqual([1, 1]);
    expect(table.rolledBackCount).toBe(2);
  });

  it("makes commit and rollback transactional on prefix violations", () => {
    const table = new VirtualTexturePageTable(TILE, { maxBytes: COST * 4 });
    const upload = plan(table, [footprint({ maxMip: 1 })], 0);
    const [mip0, mip1] = upload.admitted;
    expect(() => table.commitAdmissions([mip1!.id])).toThrow(/mip-prefix invariant/);
    expect(table.inflightCount).toBe(2);
    expect(table.residentByteCount).toBe(COST + MIP1);
    expect(() => table.rollbackAdmissions([mip0!.id])).toThrow(/mip-prefix invariant/);
    expect(table.inflightCount).toBe(2);
    expect(table.residentByteCount).toBe(COST + MIP1);
    table.commitAdmissions([mip0!.id, mip1!.id]);
    expect(table.inflightCount).toBe(0);
    expect(() => table.rollbackAdmissions([mip1!.id])).toThrow(/committed/);
    expect(() => table.commitAdmissions(["missing|0,0|mip0"])).toThrow(/Unknown/);
    expect(() => table.rollbackAdmissions(["missing|0,0|mip0"])).toThrow(/Unknown/);
  });

  it("evicts whole textures for release, refusing in-flight pages", () => {
    const table = new VirtualTexturePageTable(TILE, { maxBytes: COST * 8 });
    plan(table, [footprint({ textureId: "a", maxMip: 0 }), footprint({ textureId: "b", maxMip: 0 })], 0);
    expect(() => table.evictTexture("a")).toThrow(/in-flight/);
    table.commitAdmissions(table.plan([], 1).resident.map(page => page.id)
      .filter(id => id.startsWith("a|")));
    const evicted = table.evictTexture("a");
    expect(evicted.length).toBe(1);
    expect(table.residentMipDepth("a", 0, 0)).toBe(-1);
    expect(table.residentByteCount).toBe(COST);
    expect(table.evictTexture("gone")).toEqual([]);
    expect(() => table.evictTexture("")).toThrow(/non-empty/);
  });
});
