import { describe, expect, it } from "vitest";
import { layoutSceneSelection, type SceneSelectionLayoutItem } from "./sceneSelectionLayout";

function item(id: string, x: number, y = 0, z = 0): SceneSelectionLayoutItem {
  return {
    id,
    transform: {
      position: { x, y, z },
      rotation: { x: 0, y: 0, z: 0 },
      scale: { x: 1, y: 1, z: 1 },
    },
  };
}

describe("scene selection layout", () => {
  it("aligns to the primary object and preserves every other transform field", () => {
    const source = [item("a", 2, 1, 8), item("b", 9, 4, 3)];
    source[1]!.transform.rotation.y = 1.2;
    const result = layoutSceneSelection(source, "align", "z", "b");
    expect(result.map((entry) => entry.transform.position.z)).toEqual([3, 3]);
    expect(result[0]!.transform.position.x).toBe(2);
    expect(result[1]!.transform.rotation.y).toBe(1.2);
    expect(source[0]!.transform.position.z).toBe(8);
  });

  it("distributes objects in spatial order while preserving both extremes", () => {
    const result = layoutSceneSelection(
      [item("right", 12), item("left", 0), item("middle-b", 7), item("middle-a", 2)],
      "distribute",
      "x",
    );
    expect(result.map((entry) => entry.id)).toEqual(["left", "middle-a", "middle-b", "right"]);
    expect(result.map((entry) => entry.transform.position.x)).toEqual([0, 4, 8, 12]);
  });

  it("does not invent distribution for fewer than three objects", () => {
    expect(layoutSceneSelection([item("a", 0), item("b", 10)], "distribute", "x"))
      .toEqual([item("a", 0), item("b", 10)]);
  });
});
