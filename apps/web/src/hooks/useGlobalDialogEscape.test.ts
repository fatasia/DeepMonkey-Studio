import { afterEach, describe, expect, it, vi } from "vitest";

const lifecycle = vi.hoisted(() => ({ cleanups: [] as Array<() => void> }));
vi.mock("react", () => ({
  useEffect: (effect: () => void | (() => void)) => { const cleanup = effect(); if (cleanup) lifecycle.cleanups.push(cleanup); },
  useRef: (current: unknown) => ({ current }),
  useCallback: (callback: unknown) => callback,
}));
import { useDialogEscape, useGlobalDialogEscape } from "./useGlobalDialogEscape";
import { WorkspaceRecoveryDialog } from "../components/WorkspaceRecoveryDialog";
import { Modal } from "../components/VisionCenterPrimitives";
import { createWorkspaceRecoveryDraft } from "../studio/workspaceRecoveryStore";
import type { SceneSnapshot } from "@bim-studio/contracts";

afterEach(() => { lifecycle.cleanups.splice(0).forEach(cleanup => cleanup()); vi.unstubAllGlobals(); });

describe("global dialog Escape event ownership", () => {
  it("listens after inner controls instead of stealing Escape in capture", () => {
    const document = { addEventListener: vi.fn(), removeEventListener: vi.fn() };
    vi.stubGlobal("document", document);
    useGlobalDialogEscape();
    expect(document.addEventListener).toHaveBeenCalledWith("keydown", expect.any(Function));
  });

  it("leaves an Escape already consumed by an inner control untouched", () => {
    const backdrop = { getBoundingClientRect: () => ({ width: 400, height: 300 }), dispatchEvent: vi.fn() };
    const document = { addEventListener: vi.fn(), removeEventListener: vi.fn(), querySelectorAll: () => [backdrop] };
    vi.stubGlobal("document", document);
    vi.stubGlobal("getComputedStyle", () => ({ visibility: "visible" }));
    vi.stubGlobal("MouseEvent", class {});
    useGlobalDialogEscape();
    const event = { key: "Escape", defaultPrevented: true, preventDefault: vi.fn(), stopPropagation: vi.fn(), stopImmediatePropagation: vi.fn() };
    document.addEventListener.mock.calls[0]![1](event);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(backdrop.dispatchEvent).not.toHaveBeenCalled();
  });
});

function environment() {
  const layers: HTMLElement[] = [];
  const document = { addEventListener: vi.fn(), removeEventListener: vi.fn(), querySelectorAll: () => layers };
  vi.stubGlobal("document", document);
  vi.stubGlobal("getComputedStyle", (element: HTMLElement) => Object.assign({ visibility: "visible", display: "block", zIndex: "20" }, element.style));
  useGlobalDialogEscape();
  const press = (overrides = {}) => {
    const event = { key: "Escape", defaultPrevented: false, isComposing: false, repeat: false, preventDefault: vi.fn(), stopPropagation: vi.fn(), ...overrides };
    document.addEventListener.mock.calls[0]![1](event);
    return event;
  };
  const layer = (dismiss?: () => void, busy = false, style = {}) => {
    const element = { style, getBoundingClientRect: () => ({ width: 400, height: 300 }), dispatchEvent: vi.fn() } as unknown as HTMLElement;
    layers.push(element);
    if (dismiss) {
      const ref = useDialogEscape(dismiss, busy);
      ref(element);
      lifecycle.cleanups.push(() => ref(null));
    }
    return element;
  };
  return { layer, layers, press, document };
}

describe("explicit dialog dismissal", () => {
  it.each([true, false])("keeps Vision Escape/backdrop/X tied to its busy state (%s)", busy => {
    const { layer, press } = environment();
    const onClose = vi.fn();
    const tree = Modal({ title: "视频源", children: "表单", busy, onClose });
    const ref = tree.props.ref as (element: HTMLElement | null) => void;
    ref(layer()); lifecycle.cleanups.push(() => ref(null)); press();
    tree.props.onMouseDown();
    expect(onClose).toHaveBeenCalledTimes(busy ? 0 : 2);
    const closeButton = tree.props.children.props.children[0].props.children[1];
    expect(closeButton.props.disabled).toBe(busy);
  });

  it("calls the explicit callback without synthesizing pointer activity", () => {
    const { layer, press } = environment();
    const dismiss = vi.fn();
    const element = layer(dismiss);
    const event = press();
    expect(dismiss).toHaveBeenCalledOnce();
    expect(element.dispatchEvent).not.toHaveBeenCalled();
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(event.stopPropagation).toHaveBeenCalledOnce();
  });

  it("closes only the last rendered dialog, not every registered dialog", () => {
    const { layer, press } = environment();
    const lower = vi.fn(), top = vi.fn();
    layer(lower); layer(top); press();
    expect(top).toHaveBeenCalledOnce();
    expect(lower).not.toHaveBeenCalled();
  });

  it("uses z-index before DOM order", () => {
    const { layer, press } = environment();
    const top = vi.fn(), lower = vi.fn();
    layer(top, false, { zIndex: "80" }); layer(lower); press();
    expect(top).toHaveBeenCalledOnce();
    expect(lower).not.toHaveBeenCalled();
  });

  it("blocks Escape during busy work without dismissing a lower dialog", () => {
    const { layer, press } = environment();
    const lower = vi.fn(), top = vi.fn();
    layer(lower); layer(top, true);
    expect(press().preventDefault).toHaveBeenCalledOnce();
    expect(top).not.toHaveBeenCalled();
    expect(lower).not.toHaveBeenCalled();
  });

  it("does not bypass an unregistered top overlay", () => {
    const { layer, press } = environment();
    const lower = vi.fn();
    layer(lower); layer(); press();
    expect(lower).not.toHaveBeenCalled();
  });

  it.each([{ visibility: "hidden" }, { display: "none" }])("ignores hidden overlays: %o", style => {
    const { layer, press } = environment();
    const shown = vi.fn(), hidden = vi.fn();
    layer(shown); layer(hidden, false, style); press();
    expect(shown).toHaveBeenCalledOnce();
    expect(hidden).not.toHaveBeenCalled();
  });

  it.each([{ key: "Enter" }, { isComposing: true }, { repeat: true }, { defaultPrevented: true }])("does not consume unrelated, composing, repeated or handled keys: %o", override => {
    const { layer, press } = environment();
    const dismiss = vi.fn(); layer(dismiss);
    expect(press(override).preventDefault).not.toHaveBeenCalled();
    expect(dismiss).not.toHaveBeenCalled();
  });

  it("unregisters an unmounted ref and releases the document listener", () => {
    const { layer, press, document } = environment();
    const dismiss = vi.fn();
    const element = layer();
    const ref = useDialogEscape(dismiss); ref(element); ref(null); press();
    expect(dismiss).not.toHaveBeenCalled();
    lifecycle.cleanups.splice(0).forEach(cleanup => cleanup());
    expect(document.removeEventListener).toHaveBeenCalledWith("keydown", document.addEventListener.mock.calls[0]![1]);
  });

  it("maps recovery Escape to defer, never restore/discard/export or backdrop click", () => {
    const { layer, press } = environment();
    const scene = { id: "scene", projectId: "project", schemaVersion: 1, name: "局部草稿" } as SceneSnapshot;
    const callbacks = { onDefer: vi.fn(), onRestore: vi.fn(), onDiscard: vi.fn(), onExport: vi.fn() };
    const tree = WorkspaceRecoveryDialog({ ...callbacks, locale: "zh-CN", busy: false, draft: createWorkspaceRecoveryDraft("project", undefined, scene) });
    const ref = tree.props.ref as (element: HTMLElement | null) => void;
    ref(layer()); lifecycle.cleanups.push(() => ref(null)); press();
    expect(tree.props.onMouseDown).toBeUndefined();
    expect(callbacks.onDefer).toHaveBeenCalledOnce();
    expect(callbacks.onRestore).not.toHaveBeenCalled();
    expect(callbacks.onDiscard).not.toHaveBeenCalled();
    expect(callbacks.onExport).not.toHaveBeenCalled();
  });
});
