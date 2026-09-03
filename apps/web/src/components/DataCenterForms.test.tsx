import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { DataConnectionRecord, DataDatasetRecord } from "@bim-studio/contracts";
import { ConnectionForm, DatasetForm } from "./DataCenterForms";

vi.mock("../api", () => ({ api: {} }));

describe("ConnectionForm", () => {
  it("keeps retry policy available without blocking the primary connection path", () => {
    const html = renderToStaticMarkup(
      createElement(ConnectionForm, {
        locale: "zh-CN",
        projectId: "project:test",
        onSaved: vi.fn(),
        onCancel: vi.fn(),
        onError: vi.fn(),
      }),
    );

    expect(html).toContain("<summary>高级连接策略</summary>");
    expect(html).toContain("失败重试次数");
    expect(html).not.toContain('<details class="data-form-advanced" open="">');
    expect(html).toContain("保存连接");
  });
});

describe("DatasetForm", () => {
  const timestamp = "2026-09-03T00:00:00.000Z";
  const connection: DataConnectionRecord = {
    id: "simulation",
    projectId: "project:test",
    name: "仿真数据",
    type: "simulation",
    enabled: true,
    config: {},
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  const callbacks = { onSaved: vi.fn(), onCancel: vi.fn(), onError: vi.fn() };

  it("presents a scheduled update policy instead of an ambiguous seconds field", () => {
    const html = renderToStaticMarkup(createElement(DatasetForm, { locale: "zh-CN", projectId: "project:test", connection, ...callbacks }));
    expect(html).toContain("更新策略");
    expect(html).toContain("定时更新");
    expect(html).toContain("刷新周期（秒）");
    expect(html).not.toContain("刷新秒数");
  });

  it("explains manual mode and hides an irrelevant interval", () => {
    const initial: DataDatasetRecord = {
      id: "manual",
      projectId: "project:test",
      connectionId: connection.id,
      name: "手工台账",
      sourceKey: "metrics",
      refreshSeconds: 0,
      fields: [],
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const html = renderToStaticMarkup(createElement(DatasetForm, { locale: "zh-CN", projectId: "project:test", connection, initial, ...callbacks }));
    expect(html).toContain("手动更新");
    expect(html).toContain("打开页面时读取一次");
    expect(html).not.toContain("刷新周期（秒）");
  });
});
