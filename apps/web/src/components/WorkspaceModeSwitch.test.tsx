import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { WorkspaceModeSwitch } from "./WorkspaceModeSwitch";

describe("WorkspaceModeSwitch", () => {
  it("renders one consistent 2D, 3D, and script navigation contract", () => {
    const html = renderToStaticMarkup(
      <WorkspaceModeSwitch
        locale="zh-CN"
        active="2d"
        contextLabel="二维页面 · 生产总览"
        sceneAvailable={false}
      />,
    );

    expect(html).toContain('aria-label="编辑模式"');
    expect(html).toContain("二维页面 · 生产总览");
    expect(html).toContain('aria-current="page"');
    expect(html).toContain(">二维<");
    expect(html).toContain(">三维<");
    expect(html).toContain(">脚本<");
    expect((html.match(/disabled=""/g) ?? []).length).toBe(2);
  });
});
