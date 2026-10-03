import { describe, expect, it } from "vitest";
import { colorSoftBodyVolumes } from "./softBodyVolumeColoring.js";

const tetOf = (...indices: [number, number, number, number]) => indices;

describe("软体体积约束着色", () => {
  it("非法输入拒绝", () => {
    expect(() => colorSoftBodyVolumes([], 0)).toThrow(/particleCount/);
    expect(() => colorSoftBodyVolumes([tetOf(0, 1, 2, 5)], 5)).toThrow(/out of range/);
    expect(() => colorSoftBodyVolumes([tetOf(0, 1, 2, -1)], 5)).toThrow(/out of range/);
  });

  it("单四面体单色;共享粒子的两四面体异色", () => {
    const single = colorSoftBodyVolumes([tetOf(0, 1, 2, 3)], 4);
    expect(single.colorCount).toBe(1);
    expect(single.colorRanges).toEqual([[0, 1]]);

    const pair = colorSoftBodyVolumes([tetOf(0, 1, 2, 3), tetOf(0, 1, 2, 4)], 5);
    expect(pair.colorCount).toBe(2);
    expect(pair.colors[0]).not.toBe(pair.colors[1]);
  });

  it("仅共享一个粒子的两四面体同样异色;完全不相邻可同色", () => {
    const shareOne = colorSoftBodyVolumes([tetOf(0, 1, 2, 3), tetOf(3, 4, 5, 6)], 7);
    expect(shareOne.colors[0]).not.toBe(shareOne.colors[1]);
    const disjoint = colorSoftBodyVolumes([tetOf(0, 1, 2, 3), tetOf(4, 5, 6, 7)], 8);
    expect(disjoint.colorCount).toBe(1);
    expect(disjoint.colors[0]).toBe(disjoint.colors[1]);
  });

  it("四面体链与星形:冲突约束全部满足(每色批内无共享粒子)", () => {
    // 链:五个 tet 依次共享 3 粒子;逐对验证共享粒子的 tet 异色。
    const chain = colorSoftBodyVolumes([
      tetOf(0, 1, 2, 3), tetOf(1, 2, 3, 4), tetOf(2, 3, 4, 5), tetOf(3, 4, 5, 6), tetOf(4, 5, 6, 7),
    ], 8);
    const list = [
      tetOf(0, 1, 2, 3), tetOf(1, 2, 3, 4), tetOf(2, 3, 4, 5), tetOf(3, 4, 5, 6), tetOf(4, 5, 6, 7),
    ] as const;
    for (let a = 0; a < list.length; a += 1) {
      for (let b = a + 1; b < list.length; b += 1) {
        const shares = list[a]!.some(index => list[b]!.includes(index));
        if (shares) expect(chain.colors[a]).not.toBe(chain.colors[b]);
      }
    }
    // 星形:中心 0 参与 4 个 tet(tet 两两共享粒子→两两异色→至少 4 色)。
    const star = colorSoftBodyVolumes([
      tetOf(0, 1, 2, 3), tetOf(0, 2, 3, 4), tetOf(0, 3, 4, 5), tetOf(0, 4, 5, 1),
    ], 6);
    expect(star.colorCount).toBeGreaterThanOrEqual(4);
  });

  it("确定性:双跑同色;order/colorRanges 覆盖全部 tet", () => {
    const tets = [
      tetOf(0, 1, 2, 3), tetOf(1, 2, 3, 4), tetOf(3, 4, 5, 6), tetOf(0, 2, 5, 6),
      tetOf(2, 3, 6, 7), tetOf(4, 5, 7, 8),
    ] as const;
    const a = colorSoftBodyVolumes(tets, 9);
    const b = colorSoftBodyVolumes(tets, 9);
    expect(Array.from(a.colors)).toEqual(Array.from(b.colors));
    expect(a.colorCount).toBe(b.colorCount);
    expect(Array.from(a.order)).toEqual(Array.from(b.order));
    let covered = 0;
    for (const [start, end] of a.colorRanges) covered += end - start;
    expect(covered).toBe(tets.length);
  });
});
