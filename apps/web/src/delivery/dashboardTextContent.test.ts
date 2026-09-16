import { describe, expect, it } from "vitest";
import type { DashboardDataWidgetNode } from "@bim-studio/contracts";
import {
  DASHBOARD_FONT_ASSET_ID, clusterWidth, fontIdentity, lineHeight,
  lowerDashboardText, lowerDashboardValueText, resolveTextColor, wrapLines,
} from "./dashboardTextContent";

function node(patch: Partial<DashboardDataWidgetNode["widget"]> = {}): DashboardDataWidgetNode {
  return { id: "text", kind: "data-widget", zIndex: 5,
    frame: { x: 20, y: 30, width: 234, height: 134 },
    widget: { title: "标题", key: "text", unit: "", type: "text", content: "告警文本", ...patch } };
}

describe("Dashboard text lowering facts", () => {
  describe("resolveTextColor", () => {
    it("resolves author hex including 3/4/6/8 digit forms", () => {
      expect(resolveTextColor("#ff8800")).toEqual([1, 0x88 / 255, 0, 1]);
      expect(resolveTextColor("#f80")).toEqual([1, 0x88 / 255, 0, 1]);
      expect(resolveTextColor("#f80f")).toEqual([1, 0x88 / 255, 0, 1]);
      expect(resolveTextColor("#ff880080")[3]).toBeCloseTo(0x80 / 255, 6);
    });
    it("falls back to the real runtime default for CSS variables and garbage", () => {
      for (const value of ["var(--accent)", "rgba(1,2,3,0.5)", "", "#12345", undefined]) {
        expect(resolveTextColor(value)).toEqual([0xee / 255, 0xf2 / 255, 0xf4 / 255, 1]);
      }
    });
    it("clamps malformed long hex instead of producing NaN channels", () => {
      expect(resolveTextColor("#1234567")).toEqual([0xee / 255, 0xf2 / 255, 0xf4 / 255, 1]);
    });
  });

  describe("wrapLines", () => {
    it("wraps by declared advance: 200px box at 28px fits 14 half-width glyphs", () => {
      const lines = wrapLines("ABCDEFGHIJKLMNOPQRST", 28, 200);
      expect(lines).toEqual(["ABCDEFGHIJKLMN", "OPQRST"]);
    });
    it("treats CJK as full width and keeps each paragraph independent", () => {
      // 200/28 ≈ 7.14em:7 个全角字符填满一行。
      expect(wrapLines("告警文本测试数据", 28, 200)).toEqual(["告警文本测试数", "据"]);
      expect(wrapLines("甲\n乙", 28, 200)).toEqual(["甲", "乙"]);
    });
    it("never emits an infinite loop on a single cluster wider than the box", () => {
      expect(wrapLines("告", 28, 4)).toEqual(["告"]);
    });
    it("keeps a trailing empty paragraph for the caller to decide about", () => {
      expect(wrapLines("甲\n", 28, 200)).toEqual(["甲", ""]);
    });
    it("classifies cluster width at the real boundaries", () => {
      expect(clusterWidth("A")).toBe(0.5);
      expect(clusterWidth("告")).toBe(1);
      expect(clusterWidth("、")).toBe(1);
      // 空串宽度为 0:Array.from 不会产出空簇,但该函数不得把「无字符」算成占位宽度。
      expect(clusterWidth("")).toBe(0);
    });
  });

  describe("lowerDashboardText", () => {
    it("resolves style and centres the text block in the content box", () => {
      // 内容框 = 框内缩 17:矩形 x=37 y=47 w=200 h=100。
      const result = lowerDashboardText(node(), 7);
      expect(result.box).toEqual({ x: 37, y: 47, width: 200, height: 100 });
      expect(result.style).toEqual({ fontSize: 28, fontWeight: 600, color: [0xee / 255, 0xf2 / 255, 0xf4 / 255, 1], align: "start" });
      expect(result.lines).toEqual([{ text: "告警文本", top: 47 + (100 - lineHeight(28)) / 2 }]);
    });
    it("honours authored size, weight, colour and alignment", () => {
      const result = lowerDashboardText(node({ textColor: "#ff8800", fontSize: 40, fontWeight: 300, textAlign: "right" }), 1);
      expect(result.style).toMatchObject({ fontSize: 40, fontWeight: 300, align: "end", color: [1, 0x88 / 255, 0, 1] });
    });
    it("stacks wrapped lines by line height and drops only the trailing empty line", () => {
      const result = lowerDashboardText(node({ content: "ABCDEFGHIJKLMNOPQRST" }), 1);
      expect(result.lines.map(line => line.text)).toEqual(["ABCDEFGHIJKLMN", "OPQRST"]);
      const top = result.lines[0]!.top;
      expect(result.lines[1]!.top).toBe(top + lineHeight(28));
      const trailing = lowerDashboardText(node({ content: "第一行\n第二行\n" }), 1);
      expect(trailing.lines.map(line => line.text)).toEqual(["第一行", "第二行"]);
    });
    it("never reports text pixels as compiled while the glyph run is missing", () => {
      const result = lowerDashboardText(node(), 1);
      expect(result.contentCompiled).toBe(false);
      expect(result.compiledFields).toEqual([]);
      expect(result.reasons[0]).toContain("P1-18");
      expect(result.reasons[0]).toContain(DASHBOARD_FONT_ASSET_ID);
    });
    it("it blocks empty text and collapsed boxes with distinct reasons", () => {
      expect(lowerDashboardText(node({ content: "" }), 1).reasons[0]).toContain("空文本");
      const collapsed = lowerDashboardText({ ...node(), frame: { x: 0, y: 0, width: 30, height: 30 } }, 1);
      expect(collapsed.box).toBeNull();
      expect(collapsed.reasons[0]).toContain("内容框为空");
    });
    it("declares non-hex colour fallback and estimated wrap width", () => {
      const cssVariable = lowerDashboardText(node({ textColor: "var(--accent)" }), 1);
      expect(cssVariable.reasons.join()).toContain("已解算为默认色");
      expect(lowerDashboardText(node({ content: "ABCDEFGHIJKLMNOPQRST" }), 1).reasons.join()).toContain("声明式估算");
    });
  });

  describe("lowerDashboardValueText", () => {
    it("resolves only the title row, anchored to the top of the grid", () => {
      const result = lowerDashboardValueText(node({ type: "value", title: "有功功率", unit: "MW" }));
      expect(result.lines).toEqual([{ text: "有功功率", top: 47 }]);
      expect(result.style).toEqual({ fontSize: 10, fontWeight: 400, color: [0x7f / 255, 0x8c / 255, 0x92 / 255, 1], align: "start" });
      expect(result.reasons.join()).toContain("数据绑定");
      expect(result.contentCompiled).toBe(false);
    });
    it("does not invent a line when the widget has no title", () => {
      const result = lowerDashboardValueText(node({ type: "value", title: "" }));
      expect(result.lines).toEqual([]);
      expect(result.style).toBeNull();
    });
  });

  it("keeps the frozen font identity deterministic across revisions", () => {
    expect(fontIdentity(3, 600, "normal")).toEqual(fontIdentity(3, 600, "normal"));
    expect(fontIdentity(3, 600, "normal").id).toBe(`font:${DASHBOARD_FONT_ASSET_ID}:600:normal`);
    expect(fontIdentity(4, 600, "normal").revision).toBe(4);
    expect(fontIdentity(3, 400, "italic").style).toBe("italic");
  });
});