import { describe, expect, it, vi } from "vitest";
import { applyGroupedOrSelected } from "./sceneAppearanceDispatch";

describe("场景外观命令分派", () => {
  it("uses the current selection for a single object", () => {
    const applyObject = vi.fn();
    const applySelection = vi.fn();
    applyGroupedOrSelected(
      [],
      vi.fn(() => false),
      applyObject,
      applySelection,
    );

    expect(applySelection).toHaveBeenCalledOnce();
    expect(applyObject).not.toHaveBeenCalled();
  });

  it("updates only unlocked objects in a group", () => {
    const applyObject = vi.fn();
    const applySelection = vi.fn();
    applyGroupedOrSelected(["a", "b", "c"], (id) => id === "b", applyObject, applySelection);

    expect(applyObject.mock.calls).toEqual([["a"], ["c"]]);
    expect(applySelection).not.toHaveBeenCalled();
  });
});
