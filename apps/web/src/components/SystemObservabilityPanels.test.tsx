import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ServiceHealthRecord } from "@bim-studio/contracts";
import { SystemHealthPanel, SystemLogPanel } from "./SystemObservabilityPanels";

const t = (zh: string) => zh;

describe("system observability panels", () => {
  it("presents explainable health states and compact diagnostic actions", () => {
    const states: ServiceHealthRecord["status"][] = ["healthy", "degraded", "offline", "not-configured"];
    const health = states.map((status, index): ServiceHealthRecord => ({
      id: (["api", "web", "media", "postgres"] as const)[index]!,
      name: `服务 ${index}`,
      status,
      endpoint: `endpoint-${index}`,
      ...(status === "not-configured" ? {} : { latencyMs: index + 0.5 }),
      message: `原因 ${index}`,
      checkedAt: "2026-09-03T10:00:00.000Z",
    }));
    const html = renderToStaticMarkup(<SystemHealthPanel t={t} initialHealth={health} converters={[]} onError={vi.fn()} />);

    expect(html).toContain("健康");
    expect(html).toContain("降级");
    expect(html).toContain("离线");
    expect(html).toContain("未配置");
    expect(html).toContain('aria-label="刷新健康状态"');
    expect(html).toContain('aria-label="复制脱敏诊断"');
    expect(html).toContain('aria-label="下载诊断包"');
    expect(html).toContain('aria-label="服务 2 · 诊断详情"');
    expect(html).toContain('<pre>原因 2</pre>');
  });

  it("renders service, level, time and keyword filters with redacted export wording", () => {
    const html = renderToStaticMarkup(<SystemLogPanel
      t={t}
      auditLogs={[]}
      onError={vi.fn()}
      initialResult={{
        items: [{ id: "1", service: "api", level: "error", timestamp: "2026-09-03T10:00:00.000Z", message: "token=[REDACTED]", file: "api.err.log" }],
        total: 1,
        truncated: false,
        services: ["api"],
        generatedAt: "2026-09-03T10:00:00.000Z",
      }}
    />);

    expect(html).toContain("全部服务");
    expect(html).toContain("全部级别");
    expect(html).toContain('type="datetime-local"');
    expect(html).toContain("关键词");
    expect(html).toContain("导出当前筛选");
    expect(html).toContain("token=[REDACTED]");
  });
});
