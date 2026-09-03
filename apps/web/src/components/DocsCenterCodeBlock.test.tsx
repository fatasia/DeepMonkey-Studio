import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { copyDocumentationCode } from "./DocsCenterClipboard.js";
import { DocsCenterCodeBlock } from "./DocsCenterCodeBlock.js";

describe("DocsCenterCodeBlock", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("renders an accessible copy action and keeps the source unchanged", () => {
    const html = renderToStaticMarkup(<DocsCenterCodeBlock language="ts" value={'studio.log("设备正常");'} />);
    expect(html).toContain("复制代码：ts");
    expect(html).toContain("studio.log(&quot;设备正常&quot;);");
  });

  it("uses the clipboard API when it is available", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    await copyDocumentationCode("const ready = true;");
    expect(writeText).toHaveBeenCalledWith("const ready = true;");
  });

  it("falls back to a temporary textarea when an embedded WebView rejects clipboard access", async () => {
    const textarea = { value: "", readOnly: false, style: {}, select: vi.fn(), remove: vi.fn() };
    const appendChild = vi.fn();
    const execCommand = vi.fn(() => true);
    vi.stubGlobal("navigator", { clipboard: { writeText: vi.fn().mockRejectedValue(new Error("denied")) } });
    vi.stubGlobal("document", { body: { appendChild }, createElement: vi.fn(() => textarea), execCommand });

    await copyDocumentationCode("离线示例");

    expect(textarea.value).toBe("离线示例");
    expect(textarea.select).toHaveBeenCalledOnce();
    expect(execCommand).toHaveBeenCalledWith("copy");
    expect(textarea.remove).toHaveBeenCalledOnce();
  });
});
