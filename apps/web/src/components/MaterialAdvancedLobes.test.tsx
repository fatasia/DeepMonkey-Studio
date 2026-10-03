import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { MaterialAdvancedLobes } from "./MaterialAdvancedLobes";
import type { RendererBackend } from "../viewer/viewerTypes";
import type { SceneMaterialState } from "@bim-studio/contracts";

const render = (material: SceneMaterialState, backend: RendererBackend = "webgl", disabled = false) => renderToStaticMarkup(
  <MaterialAdvancedLobes locale="zh-CN" rendererBackend={backend} disabled={disabled} material={material} onChange={vi.fn()} />);

describe("MaterialAdvancedLobes", () => {
  it("is collapsed by default with a neutral summary and a disabled reset", () => {
    const html = render({ roughness: 0.5 });
    expect(html).toContain("<details");
    expect(html).not.toMatch(/<details[^>]* open/);
    expect(html).toContain("高级材质"); expect(html).toContain("默认关闭");
    expect(html).toMatch(/material-lobe-reset[^>]*disabled/);
  });

  it("opens itself and counts groups when a lobe is active; dependent controls are enabled", () => {
    const html = render({ roughness: 0.5, clearcoat: 0.5, sheen: 0.4, sheenColor: "#ffffff", transmission: 1 });
    expect(html).toMatch(/<details[^>]* open/);
    expect(html).toContain("已启用 3 项");
    expect(html).not.toContain("清漆强度为 0 时不生效");
    expect(html).not.toMatch(/material-lobe-reset[^>]*disabled/);
  });

  it("explains every gated control through a title and keeps one decimal convention", () => {
    const html = render({ roughness: 0.5 });
    for (const why of ["清漆强度为 0 时不生效", "光泽强度为 0 时不生效", "薄膜干涉为 0 时不生效", "需先启用透射"]) expect(html).toContain(why);
    expect(html).toContain('placeholder="∞"');
    expect(html).toContain("薄膜厚度"); expect(html).toContain("nm");
  });

  it("is blocked with a visible reason for non-PBR materials and when editing is disabled", () => {
    expect(render({})).toContain("该材质不是 PBR 材质");
    const disabled = render({ roughness: 0.5 }, "webgl", true);
    expect(disabled).toContain("当前不可编辑"); expect(disabled).toMatch(/<fieldset[^>]* disabled/);
  });

  it("shows a per-renderer capability note (three native / Deep rebuild / Wasm unsupported)", () => {
    expect(render({ roughness: 0.5 }, "webgl")).toContain("three 路径原生支持");
    expect(render({ roughness: 0.5 }, "webgpu")).toContain("重新切换到 Deep 即生效");
    const wasm = render({ roughness: 0.5 }, "wasm");
    expect(wasm).toContain("Wasm 渲染路径暂不渲染高级材质"); expect(wasm).toContain('data-tone="warning"');
  });
});