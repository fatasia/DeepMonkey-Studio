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

describe("ConnectionForm OPC UA 证书目录(T24 secure 前端接线)", () => {
  const renderOpcuaForm = (config: Record<string, string | number | boolean> = {}): string => {
    // config 必须真实并入 initial(此前 helper 硬编码 config:{} 静默丢弃参数——回读用例从未真正生效)。
    const initial: Partial<DataConnectionRecord> = { type: "opcua", name: "opc-1", config };
    return renderToStaticMarkup(
      createElement(ConnectionForm, { locale: "zh" as never, projectId: "p1", initial: initial as DataConnectionRecord, onSaved: vi.fn(), onCancel: vi.fn(), onError: vi.fn() }),
    );
  };

  it("opcua 类型渲染证书目录可选输入与说明", () => {
    const html = renderOpcuaForm();
    expect(html).toContain("证书目录（可选，安全通道）");
    expect(html).toContain("留空使用匿名 None 通道");
  });

  it("既有 certificateManagerRootDir 回读到输入框,并渲染安全模式选择", () => {
    const html = renderOpcuaForm({ certificateManagerRootDir: "D:/certs/opc", applicationName: "form-client" });
    expect(html).toContain("D:/certs/opc");
    expect(html).toContain("form-client");
    // 安全模式选择仅在有证书目录时渲染;sign 为默认选中项。
    expect(html).toContain("安全模式");
    expect(html).toContain('value="signAndEncrypt"');
    expect(html).toContain('selected=""');
  });

  it.each(["signAndEncrypt", " SIGNANDENCRYPT "])("round-trips encrypted mode %s as the selected option", (securityMode) => {
    const html = renderOpcuaForm({ certificateManagerRootDir: "pki", securityMode });
    expect(html).toContain('<option value="signAndEncrypt" selected="">');
    expect(html).not.toContain('<option value="sign" selected="">');
  });

  it("shows an invalid saved mode without displaying a false signing selection", () => {
    const html = renderOpcuaForm({ certificateManagerRootDir: "pki", securityMode: "unsupported-mode" });
    expect(html).toContain('<option value="unsupported-mode" disabled="" selected="">配置无效，请重新选择</option>');
    expect(html).not.toContain('<option value="sign" selected="">');
  });

  it("非 opcua 类型不渲染证书目录输入(零退化)", () => {
    const initial: Partial<DataConnectionRecord> = { type: "mqtt", name: "m", config: {} };
    const html = renderToStaticMarkup(
      createElement(ConnectionForm, { locale: "zh" as never, projectId: "p1", initial: initial as DataConnectionRecord, onSaved: vi.fn(), onCancel: vi.fn(), onError: vi.fn() }),
    );
    expect(html).not.toContain("证书目录（可选，安全通道）");
  });
});
