import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DocsCenter } from "./DocsCenter.js";

describe("DocsCenter", () => {
  it("renders document navigation, sections and an offline version marker", () => {
    const html = renderToStaticMarkup(<DocsCenter documentId="behavior-script" onNavigate={() => undefined} onClose={() => undefined} />);
    expect(html).toContain("使用文档");
    expect(html).toContain("编写和运行行为脚本");
    expect(html).toContain("创建行为脚本");
    expect(html).toContain("文档版本 0.9.0");
    expect(html).toContain("本文档随客户端离线提供");
  });
});
