import { describe, expect, it } from "vitest";
import {
  DEFAULT_SHORTCUTS, SHORTCUT_ACTIONS, effectiveShortcut, eventBinding,
  isTextEntryTarget, readShortcutOverrides, writeShortcutOverrides,
} from "./keymap.js";

const storage = () => {
  const map = new Map<string, string>();
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
  };
};

describe("shortcut keymap", () => {
  it("defaults cover the core tool actions", () => {
    expect(DEFAULT_SHORTCUTS["tool.translate"]).toBe("w");
    expect(SHORTCUT_ACTIONS.length).toBeGreaterThanOrEqual(8);
  });

  it("overrides round-trip through storage and fall back to defaults", () => {
    const store = storage();
    expect(readShortcutOverrides(store)).toEqual({});
    writeShortcutOverrides(store, { "tool.select": "x", bogus: "z" } as never);
    const overrides = readShortcutOverrides(store);
    expect(overrides["tool.select"]).toBe("x");
    expect(effectiveShortcut("tool.select", overrides)).toBe("x");
    expect(effectiveShortcut("tool.translate", overrides)).toBe("w");
  });

  it("corrupt storage falls back to empty overrides", () => {
    const store = { getItem: () => "{not json", setItem: () => {} };
    expect(readShortcutOverrides(store)).toEqual({});
  });

  it("normalizes modifier order and letter case", () => {
    expect(eventBinding({ ctrlKey: true, metaKey: false, shiftKey: true, altKey: false, key: "Z" })).toBe("ctrl-shift-Z".toLowerCase());
    expect(eventBinding({ ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, key: "W" })).toBe("w");
    expect(eventBinding({ ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, key: "Escape" })).toBe("Escape");
  });

  it("detects text-entry targets", () => {
    const fake = (tag: string, editable = false) => ({ tagName: tag, isContentEditable: editable }) as unknown as EventTarget;
    expect(isTextEntryTarget(fake("INPUT"))).toBe(true);
    expect(isTextEntryTarget(fake("TEXTAREA"))).toBe(true);
    expect(isTextEntryTarget(fake("DIV"))).toBe(false);
    expect(isTextEntryTarget(null)).toBe(false);
  });
});
