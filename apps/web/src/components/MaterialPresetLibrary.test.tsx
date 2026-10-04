import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { MaterialPresetLibrary } from "./MaterialPresetLibrary";
import { BUILTIN_MATERIAL_PRESETS } from "../materials/industrialMaterialPresets";
import type { UserMaterialPresetDefinition } from "@bim-studio/contracts";

const CUSTOM: UserMaterialPresetDefinition[] = [{
  id: "matpreset:test-1",
  name: "我的涂层",
  createdAt: "2026-10-04T00:00:00.000Z",
  updatedAt: "2026-10-04T00:00:00.000Z",
  values: { color: "#33587a", metalness: 0, roughness: 0.38, clearcoat: 0.55, clearcoatRoughness: 0.3 },
}];

function render(customPresets?: UserMaterialPresetDefinition[], disabled = false): string {
  return renderToStaticMarkup(<MaterialPresetLibrary
    locale="zh-CN"
    disabled={disabled}
    capture={() => ({ color: "#26292c", metalness: 0, roughness: 0.88 })}
    customPresets={customPresets}
    onApply={vi.fn()}
    onSave={vi.fn()}
    onDelete={vi.fn()}
  />);
}

describe("MaterialPresetLibrary", () => {
  it("渲染全部内置预设卡(12 个),每卡带缩略色块", () => {
    const html = render();
    const swatches = html.match(/material-preset-swatch[ "]/g) ?? [];
    expect(swatches.length).toBeGreaterThanOrEqual(BUILTIN_MATERIAL_PRESETS.length);
    for (const preset of BUILTIN_MATERIAL_PRESETS) expect(html).toContain(preset.zh);
    expect((html.match(/material-preset-card-wrap/g) ?? []).length).toBe(BUILTIN_MATERIAL_PRESETS.length);
  });

  it("按三个分组渲染:金属 / 非金属 / 玻璃与屏", () => {
    const html = render();
    expect(html).toContain("金属");
    expect(html).toContain("非金属");
    expect(html).toContain("玻璃与屏");
  });

  it("自定义预设卡渲染名称与删除按钮;无自定义时不渲染删除入口", () => {
    const withCustom = render(CUSTOM);
    expect(withCustom).toContain("我的涂层");
    expect(withCustom).toContain("material-preset-delete");
    const builtinOnly = render();
    expect(builtinOnly).not.toContain("material-preset-delete");
    expect(builtinOnly).not.toContain("我的涂层");
  });

  it("金属卡缩略为高光渐变,玻璃卡带棋盘衬底,发光卡带 emissive 内芯", () => {
    const html = render();
    expect(html).toContain("linear-gradient");
    expect(html).toContain("material-preset-swatch-glass");
    expect(html).toContain("material-preset-swatch-emissive");
    expect(html).toContain("#58c6f2");
  });

  it("卡片悬停 title 提示参数摘要(金属度/粗糙度/透射)", () => {
    const html = render();
    expect(html).toContain("金属度");
    expect(html).toContain("粗糙度");
    expect(html).toContain("透射");
  });

  it("提供存为预设入口与名称输入形态所需按钮;disabled 时全部卡不可点", () => {
    expect(render(undefined, false)).toContain("存为预设");
    const disabled = render(undefined, true);
    expect(disabled).toMatch(/material-preset-card-wrap">\s*<button[^>]*disabled/);
  });
});
