import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ApplicationErrorBoundary, ApplicationErrorFallback } from "./ApplicationErrorBoundary";

describe("application recovery boundary", () => {
  it("leaves the healthy authoring tree intact", () => {
    const html = renderToStaticMarkup(<ApplicationErrorBoundary><div>working scene</div></ApplicationErrorBoundary>);
    expect(html).toBe("<div>working scene</div>");
  });
  it("offers a user-controlled same-page recovery without claiming drafts are saved", () => {
    const html = renderToStaticMarkup(<ApplicationErrorFallback />);
    expect(html).toContain('role="alert"'); expect(html).toContain("刷新当前页面");
    expect(html).toContain("尚未保存的修改可能无法恢复"); expect(html).toContain("STUDIO_RENDER_FAILED");
    expect(html).not.toContain("href=");
    expect(ApplicationErrorBoundary.getDerivedStateFromError()).toEqual({ failed: true });
  });
  it("distinguishes bootstrap failures without exposing the original error payload", () => {
    const html = renderToStaticMarkup(<ApplicationErrorFallback startup />);
    expect(html).toContain("STUDIO_STARTUP_FAILED"); expect(html).toContain("应用未能启动");
  });
});
