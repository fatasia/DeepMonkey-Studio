import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { SceneLayerInteractions } from "./SceneLayerInteractions";

// 拖放 hook 由 useSceneLayerDrag.test 独立验收；此切片直接调用右键真实处理器。
vi.mock("./useSceneLayerDrag", () => ({ useSceneLayerDrag: () => ({}) }));

afterEach(() => vi.unstubAllGlobals());
describe("scene row context selection", () => {
  it.each([false, true])("selects an unselected right-click target without discarding an existing multi-selection: %s", selected => {
    const click = vi.fn(), focus = vi.fn();
    const menu = { open: false, querySelector: () => ({ focus }) };
    const otherMenu = { open: true };
    vi.stubGlobal("document", { querySelectorAll: () => [otherMenu] });
    const element = SceneLayerInteractions({ locale: "zh-CN", objectId: "target", selectedIds: new Set(selected ? ["other", "target"] : ["other"]), children: null });
    const row = element.props.children as ReactElement<{ onContextMenu: (event: unknown) => void }>;
    row.props.onContextMenu({ preventDefault: vi.fn(), stopPropagation: vi.fn(), currentTarget: {
      querySelector: (selector: string) => selector.startsWith("details") ? menu : { click },
    } });
    expect(click).toHaveBeenCalledTimes(selected ? 0 : 1);
    expect(menu.open).toBe(true);
    expect(otherMenu.open).toBe(false);
    expect(focus).toHaveBeenCalledOnce();
  });
});
