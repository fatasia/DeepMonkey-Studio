import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PublishedLoadState } from "./SceneViewportStatus";

const base = { locale: "zh-CN" as const, brandLogoUrl: "/brand.svg", brandName: "Studio", sceneName: "测试场景" };
describe("viewer loading feedback", () => {
  it("shows indeterminate scene retrieval without claiming 100%", () => {
    const html = renderToStaticMarkup(<PublishedLoadState {...base} viewerLoadState={{ phase: "fetching", loaded: 0, total: 0, current: "" }} />);
    expect(html).toContain('role="status"');
    expect(html).toContain("正在读取场景");
    expect(html).toContain('aria-label="场景加载进度"');
    expect(html).not.toContain('value=');
    expect(html).not.toContain("100%");
  });
  it("keeps failure text and an actionable retry instead of a permanent progress bar", () => {
    const html = renderToStaticMarkup(<PublishedLoadState {...base} viewerLoadState={{ phase: "error", loaded: 0, total: 3, current: "模型资源读取失败" }} />);
    expect(html).toContain('role="alert"');
    expect(html).toContain("模型资源读取失败");
    expect(html).toContain("重新加载");
    expect(html).not.toContain("<progress");
  });
  it("reports a completed zero-external-model scene as ready", () => {
    const html = renderToStaticMarkup(<PublishedLoadState {...base} viewerLoadState={{ phase: "ready", loaded: 0, total: 0, current: "基础几何" }} />);
    expect(html).toContain("场景已可用");
    expect(html).toContain("100%");
    expect(html).toContain('value="1"');
  });
});
