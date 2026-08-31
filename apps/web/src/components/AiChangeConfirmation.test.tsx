import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { AiChangeConfirmation } from "./AiChangeConfirmation";

describe("AiChangeConfirmation", () => {
  it("summarizes a write without exposing a heavyweight approval workflow", () => {
    const html = renderToStaticMarkup(
      <AiChangeConfirmation locale="zh-CN" widgetCount={6} onCancel={vi.fn()} onConfirm={vi.fn()} />
    );

    expect(html).toContain("写入当前二维看板");
    expect(html).toContain("生成 6 个看板组件");
    expect(html).toContain("低 · 不会自动保存或发布");
    expect(html).toContain("三维对象、脚本与数据源");
    expect(html).toContain("未返回可核验的 Capability 证据");
    expect(html).not.toContain("审批人");
    expect(html).not.toContain("审批中心");
  });
});
