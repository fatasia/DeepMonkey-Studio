import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { DataWritebackConfig } from "@bim-studio/contracts";
import { createWritebackConfigDraft, DatasetWritebackConfigFields, writebackConfigChange } from "./DatasetWritebackConfigFields";
import { DatasetForm } from "./DataCenterForms";
vi.mock("../api", () => ({ api: {} }));
const config: DataWritebackConfig = { version: 1, recordPath: "/records/{id}", fields: [{ key: "output", type: "number", required: true, min: 0, max: 100 }, { key: "status", type: "string", options: ["open", "closed", null] }] };
describe("dataset writeback configuration", () => {
  it("omits untouched settings and emits null only when explicitly disabled", () => {
    expect(writebackConfigChange(undefined, createWritebackConfigDraft())).toEqual({});
    const draft = createWritebackConfigDraft(config);
    expect(writebackConfigChange(config, draft)).toEqual({});
    expect(writebackConfigChange(config, { ...draft, enabled: false })).toEqual({ writeback: null });
  });
  it("preserves option scalar types when another setting changes", () => {
    const change = writebackConfigChange(config, { ...createWritebackConfigDraft(config), recordPath: "/values/{id}" });
    expect(change.writeback?.fields).toEqual(config.fields);
    expect(change.writeback?.recordPath).toBe("/values/{id}");
  });
  it("converts typed form values and rejects invalid ranges and boolean options", () => {
    const draft = createWritebackConfigDraft(config);
    draft.fields[0]!.min = "25";
    expect(writebackConfigChange(config, draft).writeback?.fields[0]?.min).toBe(25);
    draft.fields[0]!.min = "200";
    expect(writebackConfigChange(config, draft).error).toContain("最小值");
    draft.fields[0] = { ...draft.fields[0]!, type: "boolean", min: "", max: "", options: "yes" };
    expect(writebackConfigChange(config, draft).error).toContain("true");
  });
  it("keeps optional rules collapsed, paths named and disabled controls unavailable", () => {
    const html = renderToStaticMarkup(<DatasetWritebackConfigFields locale="zh-CN" draft={createWritebackConfigDraft(config)} disabled onChange={vi.fn()} />);
    expect(html).toContain('aria-label="填报记录路径"');
    expect(html).toContain("<summary>校验规则</summary>");
    expect(html).not.toContain('<details open="">');
    expect(html).toContain('<fieldset disabled="">');
    expect(html).toContain('aria-label="删除填报字段 1"');
  });
  it("only exposes configuration for explicitly authorized HTTP forms", () => {
    const props = { locale: "zh-CN" as const, projectId: "p", connection: { id: "http", name: "HTTP", projectId: "p", type: "http" as const, enabled: true, config: {}, createdAt: "now", updatedAt: "now" }, onSaved: vi.fn(), onError: vi.fn(), onCancel: vi.fn() };
    expect(renderToStaticMarkup(<DatasetForm {...props} />)).not.toContain("启用填报");
    expect(renderToStaticMarkup(<DatasetForm {...props} canConfigureWriteback />)).toContain("启用填报");
    expect(renderToStaticMarkup(<DatasetForm {...props} connection={{ ...props.connection, type: "simulation" }} canConfigureWriteback />)).not.toContain("启用填报");
  });
});
