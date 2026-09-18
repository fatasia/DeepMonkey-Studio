import { describe, expect, it, vi } from "vitest";
import { focusSceneObjectRow, selectSceneObjectRow } from "./sceneObjectRowEvents";

const click = (detail = 1, modifiers = {}) => ({ detail, ctrlKey: false, metaKey: false, shiftKey: false, ...modifiers });
describe("scene row selection and focus", () => {
  it.each([0, 1])("preserves ordinary and keyboard click %s toggle semantics", detail => {
    const select = vi.fn(), engine = { select: vi.fn(), focusModel: vi.fn(() => true) };
    selectSceneObjectRow(click(detail), "cube", engine, select);
    expect(select).toHaveBeenCalledExactlyOnceWith("cube", { additive: false, range: false });
    expect(engine.select).not.toHaveBeenCalled(); expect(engine.focusModel).not.toHaveBeenCalled();
  });
  it.each([{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { ctrlKey: true, shiftKey: true }])("preserves bulk selection modifiers %j", modifiers => {
    const select = vi.fn(); selectSceneObjectRow(click(1, modifiers), "cube", undefined, select);
    expect(select).toHaveBeenCalledWith("cube", { additive: !!(modifiers.ctrlKey || modifiers.metaKey), range: !!modifiers.shiftKey });
  });
  it.each([false, true])("double click ends on the clicked object, initially selected=%s", initiallySelected => {
    let selected: string | undefined = initiallySelected ? "cube" : undefined;
    const order: string[] = [];
    const engine = { select: vi.fn((id: string | undefined) => { selected = id; order.push(`select:${id}`); }),
      focusModel: vi.fn((id: string) => { expect(selected).toBe(id); order.push(`focus:${id}`); return true; }) };
    const toggle = vi.fn((id: string) => { selected = selected === id ? undefined : id; });
    selectSceneObjectRow(click(1), "cube", engine, toggle);
    selectSceneObjectRow(click(2), "cube", engine, toggle);
    focusSceneObjectRow("cube", engine);
    expect(toggle).toHaveBeenCalledOnce(); expect(selected).toBe("cube"); expect(order).toEqual(["select:cube", "focus:cube"]);
  });
  it("keeps standalone viewer fallback and missing-engine calls safe", () => {
    const engine = { select: vi.fn(), focusModel: vi.fn(() => true) };
    selectSceneObjectRow(click(), "cube", engine); expect(engine.select).toHaveBeenCalledWith("cube");
    selectSceneObjectRow(click(2), "other", engine); expect(engine.select).toHaveBeenCalledOnce();
    expect(() => focusSceneObjectRow("cube", undefined)).not.toThrow();
  });
});
