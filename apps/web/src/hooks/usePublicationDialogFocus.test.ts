import { afterEach, describe, expect, it, vi } from "vitest";
import { containPublicationDialogFocus } from "./usePublicationDialogFocus";

function fixture() {
  const listeners = new Map<string, Set<(event: unknown) => void>>();
  const layers: Element[] = [];
  const doc = { activeElement: null as Element | null, querySelectorAll: () => layers,
    addEventListener(type: string, callback: (event: unknown) => void) { const entries = listeners.get(type) ?? new Set(); entries.add(callback); listeners.set(type, entries); },
    removeEventListener(type: string, callback: (event: unknown) => void) { listeners.get(type)?.delete(callback); } };
  class Element {
    ownerDocument = doc; isConnected = true; tabIndex = 0; disabled = false; hidden = false; zIndex = "0";
    selected = false; parent?: Element; children: Element[] = []; backdrop = false; tagName = "button";
    focus() { if (this.disabled || !this.isConnected) return; doc.activeElement = this; listeners.get("focusin")?.forEach(listener => listener({})); }
    getBoundingClientRect() { return { width: this.hidden ? 0 : 100, height: this.hidden ? 0 : 100 }; }
    getAttribute(name: string) { return name === "aria-pressed" && this.selected ? "true" : null; }
    matches() { return this.disabled; }
    closest(selector: string): Element | null {
      for (let node: Element | undefined = this; node; node = node.parent) {
        if (selector.includes("dialog-backdrop") ? node.backdrop : node.hidden) return node;
      }
      return null;
    }
    contains(candidate: Element) { for (let node: Element | undefined = candidate; node; node = node.parent) if (node === this) return true; return false; }
    querySelectorAll(selector: string) { return this.children.filter(child => selector.split(",").includes(child.tagName)); }
  }
  vi.stubGlobal("HTMLElement", Element);
  vi.stubGlobal("getComputedStyle", (element: Element) => ({ display: element.hidden ? "none" : "block", visibility: "visible", zIndex: element.zIndex }));
  const trigger = new Element(); trigger.focus();
  const backdrop = new Element(); backdrop.backdrop = true; layers.push(backdrop);
  const root = new Element(); root.parent = backdrop; root.tabIndex = -1;
  const buttons = Array.from({ length: 3 }, () => { const element = new Element(); element.parent = root; return element; });
  root.children = buttons; buttons[1]!.selected = true;
  const mount = () => containPublicationDialogFocus(root as unknown as HTMLElement);
  const tab = (shiftKey = false, defaultPrevented = false) => {
    const event = { key: "Tab", shiftKey, defaultPrevented, preventDefault: vi.fn() };
    listeners.get("keydown")?.forEach(listener => listener(event)); return event;
  };
  const overlay = (zIndex: string) => { const layer = new Element(); layer.backdrop = true; layer.zIndex = zIndex; layers.push(layer); return layer; };
  return { doc, trigger, root, buttons, mount, tab, overlay, layers, listeners };
}
afterEach(() => vi.unstubAllGlobals());

describe("publication dialog focus ownership", () => {
  it("focuses the current choice and restores the opener on close", () => {
    const f = fixture(), session = f.mount(); expect(f.doc.activeElement).toBe(f.buttons[1]);
    session.dispose(); expect(f.doc.activeElement).toBe(f.trigger);
    expect(f.listeners.get("keydown")?.size).toBe(0); expect(f.listeners.get("focusin")?.size).toBe(0);
  });
  it("wraps forward and backward Tab while leaving interior navigation native", () => {
    const f = fixture(), session = f.mount();
    expect(f.tab().preventDefault).not.toHaveBeenCalled();
    f.buttons[2]!.focus(); expect(f.tab().preventDefault).toHaveBeenCalled(); expect(f.doc.activeElement).toBe(f.buttons[0]);
    expect(f.tab(true).preventDefault).toHaveBeenCalled(); expect(f.doc.activeElement).toBe(f.buttons[2]); session.dispose();
  });
  it("includes the native issue disclosure summary in both directions of the focus cycle", () => {
    const f = fixture(); f.buttons[2]!.tagName = "summary";
    const session = f.mount();
    f.buttons[0]!.focus(); f.tab(true); expect(f.doc.activeElement).toBe(f.buttons[2]);
    f.tab(); expect(f.doc.activeElement).toBe(f.buttons[0]);
    f.buttons[0]!.disabled = true; f.buttons[1]!.disabled = true; session.reconcile();
    expect(f.doc.activeElement).toBe(f.buttons[2]); session.dispose();
  });
  it("contains programmatic background focus and skips hidden or disabled controls", () => {
    const f = fixture(); f.buttons[1]!.disabled = true; f.buttons[0]!.hidden = true;
    const session = f.mount(); expect(f.doc.activeElement).toBe(f.buttons[2]);
    f.trigger.focus(); expect(f.doc.activeElement).toBe(f.buttons[2]); session.dispose();
  });
  it("focuses the dialog when busy disables every control and traps both Tab directions", () => {
    const f = fixture(), session = f.mount(); f.buttons.forEach(button => { button.disabled = true; }); session.reconcile();
    expect(f.doc.activeElement).toBe(f.root);
    expect(f.tab().preventDefault).toHaveBeenCalled(); expect(f.tab(true).preventDefault).toHaveBeenCalled();
    f.buttons[0]!.disabled = false; f.tab(); expect(f.doc.activeElement).toBe(f.buttons[0]); session.dispose();
  });
  it.each(["0", "99"])("yields keyboard and focus ownership to a later top dialog at z=%s", z => {
    const f = fixture(), session = f.mount(), top = f.overlay(z); top.focus();
    expect(f.doc.activeElement).toBe(top); expect(f.tab().preventDefault).not.toHaveBeenCalled();
    session.dispose(); expect(f.doc.activeElement).toBe(top);
  });
  it("ignores a hidden higher layer and already handled keyboard events", () => {
    const f = fixture(); f.overlay("99").hidden = true;
    const session = f.mount(); f.buttons[2]!.focus();
    expect(f.tab(false, true).preventDefault).not.toHaveBeenCalled();
    expect(f.tab().preventDefault).toHaveBeenCalled(); session.dispose();
  });
  it("survives setup-cleanup-setup without losing the original opener or duplicate listeners", () => {
    const f = fixture(), first = f.mount(); first.dispose(); const second = f.mount();
    expect(f.listeners.get("keydown")?.size).toBe(1); expect(f.doc.activeElement).toBe(f.buttons[1]);
    first.dispose(); expect(f.doc.activeElement).toBe(f.buttons[1]); second.dispose(); expect(f.doc.activeElement).toBe(f.trigger);
  });
  it.each(["removed", "disabled"])("does not restore an unavailable %s opener", state => {
    const f = fixture(), session = f.mount();
    if (state === "removed") f.trigger.isConnected = false; else f.trigger.disabled = true;
    session.dispose(); expect(f.doc.activeElement).not.toBe(f.trigger);
  });
});
