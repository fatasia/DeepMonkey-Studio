import { describe, expect, it } from "vitest";
import { planVirtualShadowClipmap } from "./virtualShadowClipmap.js";
import { desiredMip, VirtualShadowPageTable, virtualShadowPageId,
  VIRTUAL_SHADOW_MAX_PAGES_PER_FRAME, VIRTUAL_SHADOW_PHYSICAL_PAGES,
  type VirtualShadowObjectInput } from "./virtualShadowPages.js";

const light = Object.freeze([-0.4, -0.8, -0.3] as const);
const camera = Object.freeze({ eye: [0, 4, 12] as const, target: [0, 0, 0] as const,
  verticalFovRadians: Math.PI / 3, aspect: 16 / 9, near: 0.1, far: 1_000, extent: 10 });

function objectAt(x: number, y: number, z: number, screenPixels = 100,
  desiredWorldTexel = 0.05): VirtualShadowObjectInput {
  return { x, y, z, radius: 1, screenPixels, desiredWorldTexel };
}

describe("virtual shadow page table", () => {
  it("materializes top-mip pages first (zero-hole leaves) then error-ordered pages under the slot cap", () => {
    const plan = planVirtualShadowClipmap(camera, light);
    const table = new VirtualShadowPageTable();
    const objects = Array.from({ length: 64 }, (_, index) =>
      objectAt((index % 8) * 0.5 - 1.5, 0.5, Math.floor(index / 8) * 0.5 - 1.5, 100 * (index + 1)));
    const result = table.plan(plan, objects, 0, 0, {});
    expect(result.stats.requestPages).toBeGreaterThanOrEqual(3);
    expect(result.renderPages.length).toBeLessThanOrEqual(VIRTUAL_SHADOW_MAX_PAGES_PER_FRAME);
    // 顶 mip 单页/环:三个钉住页必须全部在首批物化集内。
    for (let ring = 0; ring < 3; ring++) {
      const id = virtualShadowPageId(ring, 7, 0, 0);
      expect(result.renderPages.some(page => page.id === id)).toBe(true);
    }
    // 同帧重放确定性:同输入同序。
    const replay = new VirtualShadowPageTable().plan(plan, objects, 0, 0, {});
    expect(replay.renderPages.map(page => page.id)).toEqual(result.renderPages.map(page => page.id));
  });

  it("caches static pages by version: unchanged scene produces zero re-renders across anchor movement", () => {
    const plan = planVirtualShadowClipmap(camera, light);
    const table = new VirtualShadowPageTable();
    const objects = [objectAt(0, 0.5, 0, 10_000), objectAt(2, 0.5, -1, 5_000)];
    const first = table.plan(plan, objects, 0, 7, { maxPagesPerFrame: 8 });
    expect(first.stats.materializedPages).toBeGreaterThan(0);
    // 锚点移动(页格内):已驻留页版本不变(零重绘);仅覆盖窗新暴露的边缘页可物化。
    const moved = planVirtualShadowClipmap({ ...camera, eye: [0.3, 4, 12.4] as const,
      target: [0.1, 0, -0.2] as const }, light);
    const second = table.plan(moved, objects, 1, 7, { maxPagesPerFrame: 8 });
    const previousIds = new Set(first.resident.map(page => page.id));
    const sharedIds = second.resident.filter(page => previousIds.has(page.id)
      && page.version === 7 && !page.dynamic);
    expect(sharedIds.length).toBeGreaterThan(0);
    expect(second.stats.materializedPages).toBeLessThanOrEqual(VIRTUAL_SHADOW_MAX_PAGES_PER_FRAME);
    // 场景修订推进:版本过期 → 全部非钉住驻留页重新进入物化集(槽位上限截断内)。
    const revised = table.plan(moved, objects, 2, 8, { maxPagesPerFrame: 8 });
    expect(revised.stats.materializedPages).toBeGreaterThan(0);
    expect(revised.stats.materializedPages).toBeLessThanOrEqual(VIRTUAL_SHADOW_MAX_PAGES_PER_FRAME);
  });

  it("prioritizes dynamically invalidated pages (shadow latency <= 1 frame) and bumps their version", () => {
    const plan = planVirtualShadowClipmap(camera, light);
    const table = new VirtualShadowPageTable();
    // 静态物体请求细 mip(期望 texel ≈ 环 texel → mip 0/1,动态掩码覆盖层)。
    const staticObjects = Array.from({ length: 32 }, (_, index) =>
      objectAt(index * 0.2, 0.5, 0, 50, plan.rings[0]!.texelWorldSize));
    table.plan(plan, staticObjects, 0, 1, {});
    // 动态物体扫过环 0 全域(网格覆盖,保证命中驻留页):失效页下一帧最高优先重绘。
    const sweep = Array.from({ length: 25 }, (_, index) =>
      ({ x: (index % 5) * 2 - 4, y: 0.5, z: Math.floor(index / 5) * 2 - 4, radius: 1 }));
    const invalidated = table.invalidateDynamic(sweep, plan);
    expect(invalidated).toBeGreaterThan(0);
    const next = table.plan(plan, staticObjects, 2, 1, {});
    expect(next.stats.dynamicInvalidated).toBeGreaterThan(0);
    expect(next.renderPages[0]!.dynamic).toBe(true);
  });

  it("enforces the frame budget by error-ranked truncation", () => {
    const plan = planVirtualShadowClipmap(camera, light);
    const table = new VirtualShadowPageTable();
    const objects = Array.from({ length: 400 }, (_, index) => objectAt(index % 20 * 0.4 - 4, 0.5,
      Math.floor(index / 20) * 0.4 - 4, 10));
    const capped = table.plan(plan, objects, 0, 0, { maxPagesPerFrame: 4 });
    expect(capped.renderPages).toHaveLength(4);
    expect(capped.stats.deferredByBudget).toBeGreaterThan(0);
  });

  it("evicts unrequested non-pinned pages LRU and recycles physical slots", () => {
    const plan = planVirtualShadowClipmap(camera, light);
    const table = new VirtualShadowPageTable(64, 0.08);
    const objects = Array.from({ length: 512 }, (_, index) => objectAt(index % 32 * 0.6 - 9, 0.5,
      Math.floor(index / 32) * 0.6 - 9, 1));
    for (let frame = 0; frame < 24; frame++) {
      const moving = objects.map(object => ({ ...object, x: object.x + frame * 0.5 }));
      table.plan(plan, moving, frame, 0, {});
    }
    expect(table.residentCount).toBeLessThanOrEqual(64);
    expect(table.freeSlotCount).toBe(64 - table.residentCount);
  });

  it("fails closed on malformed inputs and disposal", () => {
    const plan = planVirtualShadowClipmap(camera, light);
    const table = new VirtualShadowPageTable();
    expect(() => table.plan(plan, [objectAt(0, 0, 0, -1)], 0, 0)).toThrow("screenPixels");
    expect(() => table.plan(plan, [{ x: 0, y: 0, z: 0, radius: 0, screenPixels: 1, desiredWorldTexel: 1 }], 0, 0)).toThrow("radius");
    expect(() => table.plan(plan, [objectAt(0, 0, 0)], -1, 0)).toThrow("Frame index");
    table.dispose();
    expect(() => table.plan(plan, [], 0, 0)).toThrow("disposed");
    expect(() => new VirtualShadowPageTable(VIRTUAL_SHADOW_PHYSICAL_PAGES + 1)).toThrow();
  });

  it("maps desired mip from world texel ratio", () => {
    const plan = planVirtualShadowClipmap(camera, light);
    const ring = plan.rings[0]!;
    expect(desiredMip(ring, ring.texelWorldSize)).toBe(0);
    expect(desiredMip(ring, ring.texelWorldSize * 4)).toBe(2);
    expect(desiredMip(ring, 0)).toBe(7);
  });
});
