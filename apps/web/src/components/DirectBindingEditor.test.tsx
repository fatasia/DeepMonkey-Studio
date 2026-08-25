import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { compactValue, createDefaultDirectBinding, DirectBindingEditor, withDirectBindingSelection } from "./DirectBindingEditor";

vi.mock("../directBindingRuntime", () => ({ testDirectBinding: vi.fn() }));

describe("DirectBindingEditor", () => {
  it("renders the complete HTTP gateway contract without exposing a raw secret field", () => {
    const html = renderToStaticMarkup(<DirectBindingEditor locale="zh-CN" value={createDefaultDirectBinding("http")} onChange={() => undefined} />);
    expect(html).toContain("HTTP(S)");
    expect(html).toContain("服务端凭据引用");
    expect(html).toContain("JSONPath");
    expect(html).toContain("查询参数模板");
    expect(html).toContain("请求体模板");
    expect(html).not.toContain("密码");
  });

  it("renders WebSocket subscribe and reconnect controls", () => {
    const html = renderToStaticMarkup(<DirectBindingEditor locale="zh-CN" value={createDefaultDirectBinding("websocket")} onChange={() => undefined} />);
    expect(html).toContain("WebSocket");
    expect(html).toContain("订阅消息模板");
    expect(html).toContain("自动重连");
    expect(html).toContain("测试连接");
  });

  it("reports a successful request whose selector did not match without throwing", () => {
    expect(compactValue(undefined, "zh-CN")).toBe("未匹配到值，请检查 JSONPath / 字段");
    expect(compactValue(null, "zh-CN")).toBe("null");
  });

  it("deletes a cleared JSONPath instead of retaining the previous persisted value", () => {
    const binding = { ...createDefaultDirectBinding("http"), selection: { jsonPath: "$.old", field: "temperature" } };
    expect(withDirectBindingSelection(binding, { jsonPath: "" }).selection).toEqual({ field: "temperature" });
    expect(withDirectBindingSelection({ ...binding, selection: { jsonPath: "$.old" } }, { jsonPath: "" })).not.toHaveProperty("selection");
  });
});
