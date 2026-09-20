import { describe, expect, it } from "vitest";
import { computeProbeRelocation } from "./probeRelocation.js";
import type { ProbeAabb, ProbeVector3 } from "./probeClipmapPlan.js";

const SPACING = 1;
const BOX: ProbeAabb = { min: [-1, -1, -1], max: [1, 1, 1] };

function box(min: ProbeVector3, max: ProbeVector3): ProbeAabb {
  return { min, max };
}

describe("probe relocation solver", () => {
  it("returns zero offset for open space and safe probes", () => {
    expect(computeProbeRelocation({ cellPosition: [0, 0, 0], spacing: SPACING, obstacles: [] })).toEqual([0, 0, 0]);
    expect(computeProbeRelocation({ cellPosition: [5, 5, 5], spacing: SPACING, obstacles: [BOX] })).toEqual([0, 0, 0]);
  });

  it("pushes an embedded probe out along the thinnest axis", () => {
    // 埋在盒中心：六面等距，x 轴最先并列取正 x（确定性首轴）。
    const pushed = computeProbeRelocation({ cellPosition: [0, 0, 0], spacing: SPACING, obstacles: [BOX] });
    // 合同上限 0.5 cell：一次推不满 1.2 的深穿透由更新管线跨帧迭代补齐。
    expect(pushed[0]).toBeCloseTo(0.5, 6);
    expect(pushed[1]).toBe(0); expect(pushed[2]).toBe(0);
    // 宽松上限时一次推到表面外 margin。
    const full = computeProbeRelocation({ cellPosition: [0, 0, 0], spacing: SPACING,
      obstacles: [BOX], maxOffset: 2 });
    expect(full[0]).toBeCloseTo(1.2, 6);
    // 贴近薄墙：z 方向覆盖只有 0.1，应沿 z 逸出。
    const slab = box([-10, -10, 0.05], [10, 10, 0.15]);
    const out = computeProbeRelocation({ cellPosition: [0, 0, 0.1], spacing: SPACING, obstacles: [slab] });
    expect(Math.abs(out[2]!)).toBeGreaterThan(0);
    expect(out[0]).toBe(0); expect(out[1]).toBe(0);
  });

  it("pushes a near-surface probe away by the remaining margin", () => {
    // 探针在表面外 0.1（< 0.2 margin），沿 +x 再推 0.1。
    const near = computeProbeRelocation({ cellPosition: [1.1, 0, 0], spacing: SPACING, obstacles: [BOX] });
    expect(near[0]).toBeCloseTo(0.1, 6);
    expect(near[1]).toBe(0); expect(near[2]).toBe(0);
  });

  it("clamps the offset to maxOffset and validates inputs fail-closed", () => {
    const deep = computeProbeRelocation({ cellPosition: [0, 0, 0], spacing: SPACING, obstacles: [BOX], maxOffset: 0.3 });
    expect(Math.hypot(...deep)).toBeCloseTo(0.3, 6);
    expect(() => computeProbeRelocation({ cellPosition: [0, 0, 0], spacing: SPACING,
      obstacles: [BOX], margin: -1 })).toThrow(RangeError);
    expect(() => computeProbeRelocation({ cellPosition: [Number.NaN, 0, 0], spacing: SPACING, obstacles: [BOX] })).toThrow(RangeError);
    expect(() => computeProbeRelocation({ cellPosition: [0, 0, 0], spacing: -1, obstacles: [BOX] })).toThrow(RangeError);
    expect(() => computeProbeRelocation({ cellPosition: [0, 0, 0], spacing: SPACING,
      obstacles: [{ min: [2, 2, 2], max: [1, 1, 1] }] })).toThrow(RangeError);
  });

  it("lets the deepest obstacle dominate instead of averaging directions", () => {
    const deepSlab = box([-1, -1, -0.5], [1, 1, 0.1]);   // 探针 z=0 在其内部，穿透 0.1+…较小
    const thickBox = box([-1, -1, -1], [1, 1, 1]);        // 全方向大盒，x 逸出 1
    const offset = computeProbeRelocation({ cellPosition: [0, 0, 0], spacing: SPACING,
      obstacles: [deepSlab, thickBox] });
    // thickBox 的 x 逸出深度（1）大于 deepSlab 的最薄 z 逸出（0.1+…），主导方向应沿 x。
    expect(offset[0]).not.toBe(0);
    expect(offset[2]).toBe(0);
  });
});
