import { describe, expect, it } from "vitest";
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
});
