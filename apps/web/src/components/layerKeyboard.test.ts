import type { KeyboardEvent } from "react";
import { describe, expect, it, vi } from "vitest";
import { handleLayerTreeKeyDown, layerKeyboardOccupied, layerNavigationIndex } from "./layerKeyboard";

function fixture(key: string) {
  const controls = Array.from({ length: 3 }, () => ({ focus: vi.fn() }));
  const expander = { click: vi.fn() };
  const group = { getAttribute: vi.fn(() => "true"), querySelector: vi.fn(() => rows[0]) };
  const rows = controls.map((control, index) => ({
    matches: () => false, querySelector: vi.fn(() => control), querySelectorAll: vi.fn(() => [] as unknown[]),
    closest: vi.fn(() => index === 2 ? null : group),
  }));
  rows[0]!.querySelector = vi.fn((selector: string) => selector.includes("expander") ? expander : controls[0]) as typeof rows[0]["querySelector"];
  rows[1]!.querySelector = vi.fn((selector: string) => selector.includes("expander") ? null : controls[1]) as typeof rows[1]["querySelector"];
  const target = { closest: vi.fn((selector: string) => selector === "[data-layer-keyboard-row]" ? rows[1] : null) };
  const event = { key, target, nativeEvent: {}, defaultPrevented: false, preventDefault: vi.fn(), stopPropagation: vi.fn(),
    currentTarget: { contains: () => true, querySelectorAll: () => rows } } as unknown as KeyboardEvent<HTMLElement>;
  return { event, target, rows, controls, expander, group };
}

describe("shared layer keyboard navigation", () => {
  it.each(["Delete", "F2"])("%s invokes the focused row's explicit command once", key => {
    const { event, rows } = fixture(key), row = rows[1]!;
    const action = { disabled: false, matches: () => false, getAttribute: () => null, closest: () => row, click: vi.fn() };
    row.querySelectorAll.mockReturnValue([action]);
    expect(handleLayerTreeKeyDown(event)).toBe("handled"); expect(action.click).toHaveBeenCalledOnce();
    expect(handleLayerTreeKeyDown({ ...event, repeat: true })).toBe("blocked"); expect(action.click).toHaveBeenCalledOnce();
    expect(event.stopPropagation).toHaveBeenCalled();
  });
  it("never maps Delete on a group to a child's delete or an ungroup action", () => {
    const { event, rows } = fixture("Delete");
    const childAction = { closest: () => rows[2], click: vi.fn() };
    rows[1]!.querySelectorAll.mockReturnValue([childAction]);
    expect(handleLayerTreeKeyDown(event)).toBe("unsupported"); expect(childAction.click).not.toHaveBeenCalled();
    expect(event.stopPropagation).toHaveBeenCalledOnce();
  });
  it("blocks disabled commands and uses rename adaptation only when explicitly supported", () => {
    const { event, rows } = fixture("Delete"), row = rows[1]!;
    const action = { disabled: true, closest: () => row, click: vi.fn() };
    row.querySelectorAll.mockReturnValue([action]);
    expect(handleLayerTreeKeyDown(event)).toBe("blocked"); expect(action.click).not.toHaveBeenCalled();
    row.querySelectorAll.mockReturnValue([]);
    const rename = vi.fn(() => "handled" as const);
    expect(handleLayerTreeKeyDown({ ...event, key: "F2" }, false, { rename })).toBe("handled");
    expect(rename).toHaveBeenCalledExactlyOnceWith(row);
    expect(handleLayerTreeKeyDown({ ...event, key: "F2" })).toBe("unsupported");
  });
  it.each(["F2", "Delete"])("%s leaves text and IME input untouched", key => {
    const { event, target } = fixture(key);
    expect(handleLayerTreeKeyDown({ ...event, nativeEvent: { isComposing: true } as KeyboardEvent["nativeEvent"] })).toBeUndefined();
    target.closest.mockReturnValue({} as never);
    expect(handleLayerTreeKeyDown(event)).toBeUndefined(); expect(event.preventDefault).not.toHaveBeenCalled();
  });
  it.each([["ArrowUp", 0], ["ArrowDown", 2], ["Home", 0], ["End", 2]] as const)("%s focuses the visible row without selecting", (key, index) => {
    const { event, controls } = fixture(key); handleLayerTreeKeyDown(event);
    expect(controls[index]!.focus).toHaveBeenCalledOnce(); expect(event.preventDefault).toHaveBeenCalledOnce();
  });
  it("keeps focus at list boundaries and ignores unrelated keys", () => {
    expect(layerNavigationIndex("ArrowUp", 0, 3)).toBe(0);
    expect(layerNavigationIndex("ArrowDown", 2, 3)).toBe(2);
    expect(layerNavigationIndex("ArrowDown", -1, 0)).toBeUndefined();
    expect(layerNavigationIndex("Delete", 1, 3)).toBeUndefined();
  });
  it("returns from a child to its group without collapsing it", () => {
    const { event, controls, expander } = fixture("ArrowLeft"); handleLayerTreeKeyDown(event);
    expect(controls[0]!.focus).toHaveBeenCalledOnce(); expect(expander.click).not.toHaveBeenCalled();
  });
  it("expands a collapsed group and collapses an expanded group", () => {
    const { event, rows, target, group, expander } = fixture("ArrowRight");
    target.closest.mockImplementation(selector => selector === "[data-layer-keyboard-row]" ? rows[0]! : null);
    group.getAttribute.mockReturnValue("false"); handleLayerTreeKeyDown(event);
    expect(expander.click).toHaveBeenCalledOnce();
    group.getAttribute.mockReturnValue("true"); handleLayerTreeKeyDown({ ...event, key: "ArrowLeft" });
    expect(expander.click).toHaveBeenCalledTimes(2);
  });
  it("lets virtual lists own vertical navigation", () => {
    const { event, controls } = fixture("ArrowDown"); handleLayerTreeKeyDown(event, false);
    expect(controls[2]!.focus).not.toHaveBeenCalled(); expect(event.preventDefault).not.toHaveBeenCalled();
  });
  it.each([{ isComposing: true }, { keyCode: 229 }])("does not consume IME %j", nativeEvent => {
    const { event } = fixture("Escape"); Object.assign(event, { nativeEvent });
    handleLayerTreeKeyDown(event); expect(event.preventDefault).not.toHaveBeenCalled();
  });
  it("respects editable ancestors and modified arrows", () => {
    const { event, target } = fixture("ArrowDown");
    target.closest.mockReturnValue({} as never); expect(layerKeyboardOccupied(event)).toBe(true);
    target.closest.mockReturnValue(null); handleLayerTreeKeyDown({ ...event, ctrlKey: true });
    expect(event.preventDefault).not.toHaveBeenCalled();
  });
  it("Escape closes only the open row menu and returns to its summary", () => {
    const { event, target } = fixture("Escape"); const summary = { focus: vi.fn() };
    const menu = { open: true, querySelector: () => summary };
    target.closest.mockImplementation(selector => selector === "details[open]" ? menu as never : null);
    handleLayerTreeKeyDown(event); expect(menu.open).toBe(false); expect(summary.focus).toHaveBeenCalledOnce();
  });
});
