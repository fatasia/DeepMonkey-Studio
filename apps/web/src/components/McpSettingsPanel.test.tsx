import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { createMcpClientConfig, McpSettingsPanel } from "./McpSettingsPanel.js";

describe("MCP settings panel", () => {
  it("builds a generic HTTP client configuration without exposing a session token", () => {
    const config = createMcpClientConfig("https://studio.example/api/mcp");
    expect(config).toContain("https://studio.example/api/mcp");
    expect(config).toContain("${BIM_STUDIO_TOKEN}");
    expect(config).not.toContain("admin");
  });

  it("renders an immediate connection-check state", () => {
    const html = renderToStaticMarkup(<McpSettingsPanel locale="zh-CN" client={{ inspectMcp: () => new Promise(() => undefined) }} />);
    expect(html).toContain("正在检查 MCP 连接");
    expect(html).toContain("读取当前端点、登录身份和能力目录");
  });
});
