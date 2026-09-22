import type { DragEvent } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSceneResourceDrag } from "./useSceneResourceDrag";
import { SCENE_ASSET_MIME } from "./sceneAssetDrag";

const effects = vi.hoisted(() => [] as Array<() => (() => void)>);
vi.mock("react", () => ({ useRef: () => ({ current: undefined }), useEffect: (effect: () => (() => void)) => effects.push(effect) }));
const cleanups: Array<() => void> = [];
beforeEach(() => vi.stubGlobal("window", new EventTarget()));
afterEach(() => { cleanups.splice(0).forEach(cleanup => cleanup()); effects.length = 0; vi.unstubAllGlobals(); });
function harness() {
  const insert = vi.fn(), drag = useSceneResourceDrag("project", insert);
  cleanups.push(effects.pop()!());
  const payload = new Map<string, string>();
  const transfer = { get types() { return [...payload.keys()]; }, setData: (key: string, value: string) => payload.set(key, value), getData: (key: string) => payload.get(key) ?? "" };
  const event = () => ({ dataTransfer: transfer, preventDefault: vi.fn(), stopPropagation: vi.fn() }) as unknown as DragEvent;
  return { drag, insert, event, payload };
}

describe("resource drag commits only on an owned explicit drop", () => {
  it.each(["library", "model"] as const)("inserts %s once and rejects a replay", async source => {
    const h = harness(); h.drag.begin(h.event(), source, "one");
    const over = h.event(); h.drag.over(over); expect(over.preventDefault).toHaveBeenCalledOnce();
    await h.drag.drop(h.event()); await h.drag.drop(h.event());
    expect(h.insert).toHaveBeenCalledExactlyOnceWith({ source, id: "one" });
  });
  it.each(["Escape", "blur", "dragend"])("%s cancels without insertion and rejects a late drop", async kind => {
    const h = harness(); h.drag.begin(h.event(), "model", "one");
    const event = new Event(kind === "Escape" ? "keydown" : kind);
    if (kind === "Escape") Object.assign(event, { key: "Escape" });
    window.dispatchEvent(event); await h.drag.drop(h.event());
    expect(h.insert).not.toHaveBeenCalled();
  });
  it("rejects external/cross-editor drops and stale tokens from an earlier gesture", async () => {
    const h = harness(), other = harness();
    h.payload.set(SCENE_ASSET_MIME, '{"source":"model","id":"one"}');
    await h.drag.drop(h.event()); expect(h.insert).not.toHaveBeenCalled();
    h.drag.begin(h.event(), "model", "one"); await other.drag.drop(h.event());
    expect(other.insert).not.toHaveBeenCalled();
    const old = new Map(h.payload); h.drag.begin(h.event(), "model", "two");
    old.forEach((value, key) => h.payload.set(key, value)); await h.drag.drop(h.event());
    expect(h.insert).not.toHaveBeenCalled();
  });
  it("rejects substituted resource payload and unmounted source", async () => {
    const h = harness(); h.drag.begin(h.event(), "model", "one");
    h.payload.set(SCENE_ASSET_MIME, '{"source":"model","id":"two"}');
    await h.drag.drop(h.event()); expect(h.insert).not.toHaveBeenCalled();
    h.drag.begin(h.event(), "model", "one"); cleanups.pop()!();
    await h.drag.drop(h.event()); expect(h.insert).not.toHaveBeenCalled();
  });
  it("leaves composition Escape alone", async () => {
    const h = harness(); h.drag.begin(h.event(), "model", "one");
    const event = new Event("keydown"); Object.assign(event, { key: "Escape", isComposing: true });
    window.dispatchEvent(event); await h.drag.drop(h.event()); expect(h.insert).toHaveBeenCalledOnce();
  });
});
