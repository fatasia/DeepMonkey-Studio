import { describe, expect, it } from "vitest";
import { visibleAnnotationLabelIds, type AnnotationLabelLayoutCandidate } from "./annotationLabelLayout";

function label(overrides: Partial<AnnotationLabelLayoutCandidate> = {}): AnnotationLabelLayoutCandidate {
  return {
    id: "label-a",
    centerX: 100,
    centerY: 100,
    width: 160,
    height: 48,
    distance: 10,
    selected: false,
    ...overrides,
  };
}

describe("visibleAnnotationLabelIds", () => {
  it("keeps a selected label when it overlaps a nearer ordinary label", () => {
    const visible = visibleAnnotationLabelIds([
      label({ id: "near", distance: 2 }),
      label({ id: "selected", distance: 20, selected: true }),
    ], 800, 600);

    expect([...visible]).toEqual(["selected"]);
  });

  it("keeps non-overlapping labels and removes off-screen noise", () => {
    const visible = visibleAnnotationLabelIds([
      label({ id: "first" }),
      label({ id: "second", centerX: 360 }),
      label({ id: "outside", centerX: -500 }),
    ], 800, 600);

    expect([...visible]).toEqual(["first", "second"]);
  });

  it("hides a partially clipped ordinary label but keeps a selected one available", () => {
    const visible = visibleAnnotationLabelIds([
      label({ id: "clipped", centerX: 790 }),
      label({ id: "selected", centerX: 790, selected: true }),
    ], 800, 600);

    expect([...visible]).toEqual(["selected"]);
  });

  it("uses distance and id as deterministic priorities", () => {
    const visible = visibleAnnotationLabelIds([
      label({ id: "z", distance: 10 }),
      label({ id: "b", distance: 4 }),
      label({ id: "a", distance: 4 }),
    ], 800, 600);

    expect([...visible]).toEqual(["a"]);
  });

  it("matches exhaustive placement for dense scenes, boundary contacts and selected overflow", () => {
    let seed = 909;
    const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
    for (let run = 0; run < 25; run += 1) {
      const candidates = Array.from({ length: 1_000 }, (_, index) => label({
        id: `${run}-${index}`, centerX: Math.floor(random() * 17_000) - 300,
        centerY: Math.floor(random() * 9_000) - 300, width: 20 + random() * 220,
        height: 10 + random() * 80, distance: Math.floor(random() * 100), selected: index % 71 === 0,
      }));
      candidates.push(label({ id: "oversized", selected: true, centerX: -20_000, width: 20_000 }));
      candidates.push(label({ id: "touch-a", centerX: 100, centerY: 100, width: 80, height: 20, distance: -1 }));
      candidates.push(label({ id: "touch-b", centerX: 204, centerY: 100, width: 80, height: 20, distance: -1 }));
      expect([...visibleAnnotationLabelIds(candidates, 16_384, 8_192)])
        .toEqual(exhaustiveVisibleIds(candidates, 16_384, 8_192));
    }
  });
});

// 测试保留直接穷举作为独立参考，防止空间索引漏查相邻单元或改变旧可见集合。
function exhaustiveVisibleIds(candidates: AnnotationLabelLayoutCandidate[], width: number, height: number): string[] {
  const occupied: Array<{ left: number; top: number; right: number; bottom: number }> = [];
  const ids: string[] = [];
  for (const item of [...candidates].sort((a, b) => Number(b.selected) - Number(a.selected) || a.distance - b.distance || a.id.localeCompare(b.id))) {
    const halfWidth = Math.max(item.width, 1) / 2 + 12;
    const halfHeight = Math.max(item.height, 1) / 2 + 12;
    const rect = { left: item.centerX - halfWidth, right: item.centerX + halfWidth,
      top: item.centerY - halfHeight, bottom: item.centerY + halfHeight };
    if (!item.selected && (rect.left < 0 || rect.top < 0 || rect.right > width || rect.bottom > height)) continue;
    if (!item.selected && occupied.some(other => other.left < rect.right && other.right > rect.left && other.top < rect.bottom && other.bottom > rect.top)) continue;
    ids.push(item.id);
    occupied.push(rect);
  }
  return ids;
}
