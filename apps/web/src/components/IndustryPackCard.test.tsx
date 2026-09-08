import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { IndustryPackCard } from "./IndustryPackCard";
import { INDUSTRY_TEMPLATE_PACKS } from "./industryTemplatePackCatalog";

describe("industry pack preview", () => {
  it("renders actual page nodes with selectable page names and one import action", () => {
    const html = renderToStaticMarkup(<IndustryPackCard locale="zh-CN" pack={INDUSTRY_TEMPLATE_PACKS[0]!}
      page={{ id: "base", name: "base", width: 1920, height: 1080, viewportFit: "contain", nodes: [] }} onInsert={() => {}} />);
    expect(html.match(/data-template-node=/g)).toHaveLength(10);
    expect(html.match(/aria-pressed=/g)).toHaveLength(5);
    expect(html).toContain("制造设备运行包");
    expect(html).toContain("生产总览模板预览");
    expect(html.match(/导入整包/g)).toHaveLength(1);
    expect(html).not.toContain("数据待绑定");
    expect(html).toContain("--template-accent:var(--accent)");
    expect(html).toContain("--template-surface:var(--surface-1)");
    expect(html).toContain("--template-text:var(--text-strong)");
  });
});
