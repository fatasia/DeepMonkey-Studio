import { afterEach, describe, expect, it, vi } from "vitest";
import { useLayerRenameFocus } from "./useLayerRenameFocus";
vi.mock("react", () => ({ useRef: (current: unknown) => ({ current }), useEffect: () => undefined }));
afterEach(() => vi.unstubAllGlobals());
function setup() {
  const frames = new Map<number, FrameRequestCallback>(); let serial = 0;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frames.set(++serial, callback); return serial; });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  const input = { dataset: { layerRenameId: "new" }, matches: () => false, readOnly: false, focus: vi.fn(), select: vi.fn() };
  const query = vi.fn(() => [input]); vi.stubGlobal("document", { querySelectorAll: query });
  const flush = () => { const next = frames.entries().next().value; if (next) { frames.delete(next[0]); next[1](0); } };
  return { input, query, flush, frames };
}
describe("rename focus after selection", () => {
  it("waits for the exact new selection and selects the existing field", () => {
    const h = setup(), prepare = vi.fn(), request = useLayerRenameFocus("dashboard");
    h.query.mockReturnValueOnce([]); request("new", prepare);
    expect(prepare).toHaveBeenCalledOnce(); expect(h.input.focus).not.toHaveBeenCalled();
    h.flush(); expect(h.input.focus).not.toHaveBeenCalled(); h.flush();
    expect(h.input.focus).toHaveBeenCalledOnce(); expect(h.input.select).toHaveBeenCalledOnce();
  });
  it("cancels an earlier focus request and refuses disabled fields", () => {
    const h = setup(), request = useLayerRenameFocus("scene");
    request("old", vi.fn()); request("new", vi.fn()); expect(h.frames.size).toBe(1);
    h.input.matches = () => true; h.flush(); expect(h.input.focus).not.toHaveBeenCalled();
  });
  it("never focuses a stale selection when the requested object disappears", () => {
    const h = setup(); useLayerRenameFocus("scene")("deleted", vi.fn());
    h.flush(); h.flush(); h.flush();
    expect(h.frames.size).toBe(0); expect(h.input.focus).not.toHaveBeenCalled();
  });
});
