import { describe, expect, it, vi } from "vitest";
import { createMcpApi } from "./mcpApi.js";

describe("MCP settings API", () => {
  it("reads live discovery, role-filtered tools, and the shared capability catalog", async () => {
    const calls = vi.fn();
    const request = async <T,>(url: string, init?: RequestInit): Promise<T> => {
      calls(url, init);
      if (url === "/api/capabilities") return { capabilities: [{ id: "operations.read", permissions: ["operations.read"] }] } as T;
      const method = JSON.parse(String(init?.body)).method;
      if (method === "server/discover") return { jsonrpc: "2.0", id: 1, result: { supportedVersions: ["2026-07-28"], capabilities: { tools: {} }, _meta: { "io.modelcontextprotocol/serverInfo": { name: "bim-industrial-core", version: "1.1.0" } } } } as T;
      return { jsonrpc: "2.0", id: 1, result: { tools: [{ name: "industrial.operations.read", title: "读取运营", annotations: { readOnlyHint: true } }] } } as T;
    };
    const client = createMcpApi(request, () => "https://studio.example/api/mcp", () => true);

    const result = await client.inspectMcp();

    expect(result).toMatchObject({ endpoint: "https://studio.example/api/mcp", authenticated: true,
      protocolVersion: "2026-07-28", serverName: "bim-industrial-core", resourcesSupported: false });
    expect(result.tools).toHaveLength(1);
    expect(calls).toHaveBeenCalledWith("/api/mcp", expect.objectContaining({
      headers: expect.objectContaining({ "mcp-protocol-version": "2026-07-28" }),
    }));
  });
});
