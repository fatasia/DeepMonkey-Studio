import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AiSampleRunner } from "./AiSampleRunner";

describe("sample execution disclosure", () => {
  it("exposes runnable maintenance input as an explicitly local shadow sample", () => {
    const html = renderToStaticMarkup(<AiSampleRunner projectId="p1" kind="maintenance" />);
    expect(html).toContain("一键运行样例");
    expect(html).toContain("仅作影子评估");
    expect(html).not.toContain("已完成");
  });
  it("offers bundled local model inference, in either locale", () => {
    expect(renderToStaticMarkup(<AiSampleRunner projectId="p1" kind="vision" />)).toContain("在本机执行真实识别");
    expect(renderToStaticMarkup(<AiSampleRunner projectId="p1" kind="vision" locale="en-US" />)).toContain("bundled YOLOX-Nano");
  });
});
