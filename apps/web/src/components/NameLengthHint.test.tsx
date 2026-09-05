import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { NameLengthHint } from "./NameLengthHint";

describe("NameLengthHint", () => {
  it("counts Unicode code points and uses a non-blocking recommendation", () => {
    const html = renderToStaticMarkup(<NameLengthHint id="name-help" value="工位🔧" locale="zh-CN" />);
    expect(html).toContain('id="name-help"');
    expect(html).toContain("3 字符");
    expect(html).not.toContain("is-long");
  });
  it("explains long names without truncating or promising an API maximum", () => {
    const html = renderToStaticMarkup(<NameLengthHint id="name-help" value={"车".repeat(210)} locale="zh-CN" />);
    expect(html).toContain("210 字符");
    expect(html).toContain("完整名称会保留");
    expect(html).toContain("is-long");
    expect(html).not.toContain("最多");
  });
});
