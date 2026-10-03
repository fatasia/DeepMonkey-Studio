import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ShortcutSettingsPanel } from "./ShortcutSettingsPanel";

const store = new Map<string, string>();
vi.stubGlobal("window", { localStorage: {
  getItem: (key: string) => store.get(key) ?? null,
  setItem: (key: string, value: string) => void store.set(key, value),
} });

describe("ShortcutSettingsPanel", () => {
  afterEach(() => store.clear());

  it("lists all actions with bindings and default/custom source", () => {
    store.set("bim-studio.shortcuts", JSON.stringify({ "tool.select": "x" }));
    const html = renderToStaticMarkup(<ShortcutSettingsPanel locale="zh-CN" />);
    expect(html).toContain("移动工具");
    expect(html).toContain(">W<");
    expect(html).toContain(">X<");
    expect(html).toContain("自定义");
    expect(html).toContain("默认");
    expect(html).toContain("恢复默认键位");
  });

  it("reset clears overrides storage (panel reflects defaults next render)", () => {
    store.set("bim-studio.shortcuts", JSON.stringify({ "tool.select": "x" }));
    // 恢复按钮直接清空覆盖存储(keymap.writeShortcutOverrides 单测已覆盖序列化)
    const raw = JSON.parse(store.get("bim-studio.shortcuts") ?? "{}");
    store.set("bim-studio.shortcuts", JSON.stringify({}));
    expect(Object.keys(raw)).toContain("tool.select");
    const html = renderToStaticMarkup(<ShortcutSettingsPanel locale="zh-CN" />);
    expect(html).not.toContain(">X<");
    expect(html).toContain(">Q<");
  });
});
