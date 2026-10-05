import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { McpInspection } from "../apiClients/mcpApi.js";
import { createMcpClientConfig, McpSettingsPanel } from "./McpSettingsPanel.js";

// 面板的数据在 useEffect→Promise 里装载;hook 同步化让静态渲染能走到已加载分支。
const harness = vi.hoisted(() => ({ cursor: 0, cells: [] as unknown[], effects: new Set<number>() }));
vi.mock("react", async original => ({ ...await original<typeof import("react")>(),
  useRef: (value: unknown) => harness.cells[harness.cursor++] ??= { current: value },
  useState: (initial: unknown) => {
    const index = harness.cursor++; if (!(index in harness.cells)) harness.cells[index] = initial;
    return [harness.cells[index], (value: unknown) => { harness.cells[index] = value; }];
  },
  useEffect: (fn: () => unknown) => { const index = harness.cursor++; if (!harness.effects.has(index)) { harness.effects.add(index); fn(); } },
  useMemo: (factory: () => unknown) => factory(),
}));
async function flush() { for (let i = 0; i < 8; i++) await Promise.resolve(); }

async function renderPanel(inspection: McpInspection): Promise<string> {
  harness.cursor = 0;
  // 首次渲染只触发装载 effect;微任务清空后二次渲染才是已加载分支。
  renderToStaticMarkup(<McpSettingsPanel locale="zh-CN" client={{ inspectMcp: () => Promise.resolve(inspection) }} />);
  for (let i = 0; i < 8; i++) await Promise.resolve();
  harness.cursor = 0;
  return renderToStaticMarkup(<McpSettingsPanel locale="zh-CN" client={{ inspectMcp: () => Promise.resolve(inspection) }} />);
}
function textOf(node: ReactNode): string {
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (typeof node === "string" || typeof node === "number") return String(node);
  return isValidElement<Record<string, unknown>>(node) ? textOf(node.props.children as ReactNode) : "";
}
function renderText(inspection: McpInspection): string {
  harness.cursor = 0;
  const tree = McpSettingsPanel({ locale: "zh-CN", client: { inspectMcp: () => Promise.resolve(inspection) } }) as ReactElement;
  return textOf(tree);
}

describe("MCP settings panel", () => {
  afterEach(() => { harness.cursor = 0; harness.cells = []; harness.effects.clear(); });

  it("builds a generic HTTP client configuration without exposing a session token", () => {
    const config = createMcpClientConfig("https://studio.example/api/mcp");
    expect(config).toContain("https://studio.example/api/mcp");
    expect(config).toContain("${BIM_STUDIO_TOKEN}");
    expect(config).not.toContain("admin");
  });

  it("renders an immediate connection-check state", () => {
    harness.cursor = 0; harness.cells = []; harness.effects.clear();
    const html = renderToStaticMarkup(<McpSettingsPanel locale="zh-CN" client={{ inspectMcp: () => new Promise(() => undefined) }} />);
    expect(html).toContain("正在检查 MCP 连接");
    expect(html).toContain("读取当前端点、登录身份和能力目录");
  });

  it("labels the server version and the protocol version separately and notes the legacy handshake tier (P2-8)", async () => {
    const inspection: McpInspection = {
      endpoint: "/api/mcp", authenticated: true,
      protocolVersion: "2026-07-28", supportedVersions: ["2026-07-28", "2025-11-25", "2025-06-18"],
      serverName: "bim-industrial-core", serverVersion: "1.1.0",
      tools: [], resources: [], capabilities: [], resourcesSupported: false,
    };
    const html = await renderPanel(inspection);
    const text = renderText(inspection);
    // 服务版本与协议版本文案分离,不再共用一个含混的"协议版本"标签。
    expect(text).toContain("服务版本");
    expect(html).toContain("MCP 协议版本");
    expect(html).toContain("2026-07-28");
    // 现代协议通道与 initialize 兼容握手的差异在 UI 注明,版本号读同一服务端发现载荷。
    expect(html).toContain("旧版客户端 initialize 握手兼容 2025-11-25 / 2025-06-18");
  });

  it("omits the handshake note when the server advertises a single protocol version", async () => {
    const inspection: McpInspection = {
      endpoint: "/api/mcp", authenticated: true,
      protocolVersion: "2026-07-28", supportedVersions: ["2026-07-28"],
      serverName: "bim-industrial-core", serverVersion: "1.1.0",
      tools: [], resources: [], capabilities: [], resourcesSupported: false,
    };
    const html = await renderPanel(inspection);
    expect(html).toContain("MCP 协议版本");
    expect(html).not.toContain("initialize 握手兼容");
  });
});
