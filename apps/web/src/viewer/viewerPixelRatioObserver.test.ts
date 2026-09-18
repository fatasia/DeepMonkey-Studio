import { afterEach, describe, expect, it, vi } from "vitest";
import { observeViewerPixelRatio } from "./viewerPixelRatioObserver";

afterEach(() => vi.unstubAllGlobals());

describe("observeViewerPixelRatio", () => {
  it("rearms resolution queries, handles window resize and releases every listener", () => {
    const queries: EventTarget[] = [];
    const host = Object.assign(new EventTarget(), {
      devicePixelRatio: 1,
      matchMedia: vi.fn(() => {
        const query = new EventTarget();
        queries.push(query);
        return query;
      }),
    });
    vi.stubGlobal("window", host);
    const changed = vi.fn();
    const dispose = observeViewerPixelRatio(changed);
    host.devicePixelRatio = 2;
    queries[0]!.dispatchEvent(new Event("change"));
    expect(host.matchMedia).toHaveBeenLastCalledWith("(resolution: 2dppx)");
    expect(changed).toHaveBeenCalledTimes(1);
    queries[0]!.dispatchEvent(new Event("change"));
    expect(changed).toHaveBeenCalledTimes(1);
    host.dispatchEvent(new Event("resize"));
    expect(changed).toHaveBeenCalledTimes(2);
    dispose();
    queries.at(-1)!.dispatchEvent(new Event("change"));
    host.dispatchEvent(new Event("resize"));
    expect(changed).toHaveBeenCalledTimes(2);
  });
});
