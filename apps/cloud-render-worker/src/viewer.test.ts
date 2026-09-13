import { describe, expect, it } from "vitest";
import { runInNewContext } from "node:vm";
import { viewerHtml } from "./viewer.js";

describe("cloud render viewer page", () => {
  it("bounds signaling requests and exposes failures in the page", () => {
    const html = viewerHtml("session-1", []);

    expect(html).toContain("AbortSignal.timeout(8000)");
    expect(html).toContain("const deadline=Date.now()+30000");
    expect(html).toContain("云渲染连接失败");
    expect(html).toContain("pc.close()");
  });

  it("escapes embedded session configuration", () => {
    const html = viewerHtml("session-</script>", []);
    expect(html).not.toContain('"sessionId":"session-</script>"');
    expect(html).toContain("\\u003c/script>");
  });

  it("offers playback recovery when autoplay is denied instead of claiming media is playing", async () => {
    const handlers: Record<string, Record<string, () => void>> = {};
    const elements = Object.fromEntries(["video", "status", "play", "diagnostics"].map(id => [id, {
      hidden: id === "play", textContent: "", className: "status", focus() {},
      addEventListener(event: string, handler: () => void) { (handlers[id] ??= {})[event] = handler; },
    }]));
    let denied = true;
    Object.assign(elements.video, { play: async () => {
      if (denied) throw new Error("NotAllowedError");
      handlers.video.playing();
    } });
    let peer: any;
    class Peer {
      connectionState = "connected";
      constructor() { peer = this; }
    }
    const script = viewerHtml("session-1", []).match(/<script type="module">([\s\S]*?)<\/script>/)?.[1];
    expect(script).toBeDefined();
    runInNewContext(script!, {
      document: { querySelector: (selector: string) => elements[selector.slice(1)] },
      RTCPeerConnection: Peer, location: { hash: "", pathname: "/viewer/session-1" },
      history: { replaceState() {} }, URLSearchParams, AbortSignal: { timeout() {} },
      fetch: () => new Promise(() => {}),
    });
    peer.ondatachannel({ channel: { label: "input", readyState: "open" } });
    peer.ontrack({ streams: [{}] });
    await new Promise(resolve => setImmediate(resolve));
    expect(elements.play.hidden).toBe(false);
    expect(elements.status.textContent).toContain("点击开始观看");
    expect(elements.status.className).toBe("status");
    denied = false;
    handlers.play.click();
    await new Promise(resolve => setImmediate(resolve));
    expect(elements.play.hidden).toBe(true);
    expect(elements.status.textContent).toBe("媒体与输入已连接");
    expect(elements.status.className).toBe("status ready");
  });
});
