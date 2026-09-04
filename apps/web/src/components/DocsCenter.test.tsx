import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DocsCenter } from "./DocsCenter.js";

describe("DocsCenter", () => {
  it("renders document navigation, sections and an offline version marker", () => {
    const html = renderToStaticMarkup(<DocsCenter systemName="Deep Monkey Studio" documentId="behavior-script" onNavigate={() => undefined} onClose={() => undefined} />);
    expect(html).toContain("Deep Monkey Studio 文档");
    expect(html).toContain("返回");
    expect(html).toContain("编写和运行行为脚本");
    expect(html).toContain("创建行为脚本");
    expect(html).toContain("文档版本 2026.09");
    expect(html).toContain("本文档随客户端离线提供");
    expect(html).toContain("复制代码");
    expect(html).toContain("相邻文档");
    expect(html).toContain("aria-keyshortcuts=\"Control+K Meta+K /\"");
    expect(html.indexOf("返回")).toBeLessThan(html.indexOf("Deep Monkey Studio 文档"));
  });
});
