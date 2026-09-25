import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DesktopWindowFrame } from "./DesktopWindowFrame";

afterEach(() => vi.unstubAllGlobals());

describe("DesktopWindowFrame branding", () => {
  it("uses the product logo in the desktop titlebar", () => {
    vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
    const html = renderToStaticMarkup(<DesktopWindowFrame><main>工作台</main></DesktopWindowFrame>);

    expect(html).toContain('class="desktop-window-logo"');
    expect(html).toContain('src="/brand/logo-titlebar.png"');
    expect(html).not.toContain("desktop-window-mark");
    expect(html).toContain("DeepMonkey Studio");
  });

  it("does not add desktop chrome in a browser", () => {
    vi.stubGlobal("window", {});
    const html = renderToStaticMarkup(<DesktopWindowFrame><main>工作台</main></DesktopWindowFrame>);

    expect(html).toBe("<main>工作台</main>");
  });
});
