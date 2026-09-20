import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { SceneXrPanel, type SceneXrCapabilities } from "./SceneXrPanel";

const READY_CAPABILITIES: SceneXrCapabilities = {
  checking: false,
  secure: true,
  webxr: true,
  vr: true,
  ar: true,
};

describe("SceneXrPanel capability presentation", () => {
  it("shows the WebGL-only reason and disables both modes while Deep WebGPU is active", () => {
    const html = renderToStaticMarkup(
      <SceneXrPanel
        locale="zh-CN"
        rendererBackend="webgpu"
        capabilities={READY_CAPABILITIES}
        onStart={vi.fn()}
        onEnd={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    // 原因可见而非只给不可点的按钮；按钮保持禁用。
    expect(html).toContain("仅 Three WebGL 渲染后端支持");
    expect(html).toContain("Deep WebGPU 激活期间不可用");
    expect(html).toContain("! Deep WebGPU");
    expect((html.match(/disabled/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });

  it("keeps both modes enterable on a WebGL backend with VR and AR detected", () => {
    const html = renderToStaticMarkup(
      <SceneXrPanel
        locale="zh-CN"
        rendererBackend="webgl"
        capabilities={READY_CAPABILITIES}
        onStart={vi.fn()}
        onEnd={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(html).not.toContain("仅 Three WebGL 渲染后端支持");
    expect(html).toContain("✓ Three WebGL");
    expect(html).not.toContain("disabled");
  });

  it("hides the reason block while the device probe is still checking", () => {
    const html = renderToStaticMarkup(
      <SceneXrPanel
        locale="zh-CN"
        rendererBackend="webgl"
        capabilities={{ ...READY_CAPABILITIES, checking: true, vr: false, ar: false }}
        onStart={vi.fn()}
        onEnd={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(html).toContain("…");
    expect(html).not.toContain("xr-block-reasons");
  });
});
