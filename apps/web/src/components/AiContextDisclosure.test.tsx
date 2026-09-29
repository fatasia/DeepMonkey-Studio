import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AiContextDisclosure, CHAT_HISTORY_WINDOW } from "./AiContextDisclosure";

/**
 * K6 回归锁（审计 20260929 §一 K6：chat 历史窗口只发最近 6 轮，丢弃行为零披露）。
 * 80k 上下文截断早有警示上浮，而 6 轮窗口裁剪此前无任何 UI 说明——用户以为
 * 助手记得全部对话。以下断言锁死"sent < total 必须披露、否则必须静默"。
 */
describe("AiContextDisclosure history window (K6)", () => {
  const base = { locale: "zh-CN" as const, mode: "platform" as const, context: {}, sources: [], loading: false };

  it("discloses trimmed turns once the conversation exceeds the request window", () => {
    const html = renderToStaticMarkup(<AiContextDisclosure {...base} historyWindow={{ sent: 6, total: 11 }} />);
    expect(html).toContain("仅发送最近 6 轮对话");
    expect(html).toContain("更早的 5 轮");
    expect(html).toContain("不会参与本次回答");
  });

  it("stays silent while every turn fits inside the window", () => {
    const html = renderToStaticMarkup(<AiContextDisclosure {...base} historyWindow={{ sent: 6, total: 6 }} />);
    expect(html).not.toContain("仅发送最近");
  });

  it("stays silent when no window information is provided", () => {
    const html = renderToStaticMarkup(<AiContextDisclosure {...base} />);
    expect(html).not.toContain("仅发送最近");
  });

  it("exposes the shared window constant so the hook and the UI cannot drift silently", () => {
    expect(CHAT_HISTORY_WINDOW).toBe(6);
  });
});
