import { renderToStaticMarkup } from "react-dom/server";
import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";

vi.mock("../api", () => ({ api: {} }));

import { AiSettingsPanel } from "./SystemCenter";

const t = (zh: string, en: string) => zh;

const initial = {
  providerId: "ai.openai-compatible",
  baseUrl: "https://moacode.test/v1",
  model: "gpt-5.5",
  protocol: "responses" as const,
  apiKeyConfigured: true,
  temperature: 0.2,
  failover: {
    enabled: true,
    baseUrl: "http://localhost:46037/v1",
    model: "gpt-5.6-sol",
    protocol: "responses" as const,
    apiKeyConfigured: true,
  },
};

const providers = [{
  id: "ai.openai-compatible",
  version: "1.0.0",
  label: "OpenAI 兼容模型",
  execution: "in-process" as const,
  permissions: ["ai.invoke"],
  streaming: true,
  timeoutMs: 90_000,
}];

function renderPanel(overrides: Partial<Parameters<typeof AiSettingsPanel>[0]> = {}) {
  return renderToStaticMarkup(
    <AiSettingsPanel
      t={t}
      initial={initial}
      providers={providers}
      onSaved={vi.fn()}
      onError={vi.fn()}
      {...overrides}
    />,
  );
}

describe("SystemCenter AI settings panel", () => {
  it("keeps the original settings form structure and renders the failover section as progressive enhancement", () => {
    const html = renderPanel();
    expect(html).toContain("system-ai-settings");
    expect(html).toContain("已配置，留空保持不变");
    expect(html).toContain("测试连接");
    expect(html).toContain("保存配置");
    expect(html).toContain('value="https://moacode.test/v1"');
    expect(html).toContain('value="gpt-5.5"');
    // failover 分层：独立区块、复选框、备用端点与模型
    expect(html).toContain("备用模型自动切换");
    expect(html).toContain("data-testid=\"ai-failover-section\"");
    expect(html).toContain('type="checkbox" checked=""');
    expect(html).toContain('value="http://localhost:46037/v1"');
    expect(html).toContain('value="gpt-5.6-sol"');
    expect(html).toContain("鉴权错误不切换");
  });

  it("offers the reasoning effort control for the OpenAI-compatible provider and disables it otherwise", () => {
    const enabled = renderPanel();
    expect(enabled).toContain("思考深度");
    expect(enabled).toContain("默认（保持现有行为）");
    expect(enabled).toContain("深度（更慢更严谨）");
    expect(enabled).not.toContain("disabled=\"\"");
    const unsupported = renderPanel({ initial: { ...initial, providerId: "ai.custom" } });
    expect(unsupported).toContain("当前模型服务插件不支持推理深度控制");
    expect(unsupported).toContain('disabled=""');
  });

  it("exposes the model catalog datalist plus fetch and refresh entries", () => {
    const html = renderPanel();
    expect(html).toContain('list="ai-model-options"');
    expect(html).toContain('id="ai-model-options"');
    expect(html).toContain("拉取模型列表");
  });

  it("renders a quiet standby hint before any telemetry exists, and never renders telemetry without data", () => {
    const html = renderPanel();
    expect(html).toContain("尚未有请求记录");
    expect(html).not.toContain("data-testid=\"ai-telemetry\"");
    expect(html).not.toContain("最近一次切换");
  });

  it("keeps the new sections inside the existing two-column grid system", async () => {
    const css = await readFile(new URL("../styles/platform-pages.css", import.meta.url), "utf8");
    expect(css).toContain(".system-ai-section { display: grid; gap: 8px; padding-top: 11px; border-top: 1px solid #29373d; grid-column: 1 / -1; }");
    expect(css).toContain(".system-ai-telemetry { display: grid; gap: 5px;");
  });
});
