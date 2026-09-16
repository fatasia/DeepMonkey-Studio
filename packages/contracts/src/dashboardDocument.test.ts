import { describe, expect, it } from "vitest";
import source from "../fixtures/application-v2-worker-behavior.json";
import { assertApplicationDocument } from "./application.js";
import { assertDashboardDocument, createDashboardDocument } from "./dashboardDocument.js";

function application() { const value = structuredClone(source); assertApplicationDocument(value); return value; }

describe("DashboardDocument v1 source envelope", () => {
  it("preserves the complete authoring document and detaches the snapshot", () => {
    const input = application(), original = structuredClone(input);
    const result = createDashboardDocument(input, input.pages[0]!.id);
    input.metadata.name = "changed"; input.pages[0]!.nodes = []; input.scripts = [];
    expect(result.application).toEqual(original);
    expect(() => assertDashboardDocument(JSON.parse(JSON.stringify(result)))).not.toThrow();
  });
  it("requires an existing explicit entry page", () => {
    expect(() => createDashboardDocument(application(), "missing")).toThrow("入口页不存在");
    expect(() => createDashboardDocument(application(), "")).toThrow("指定入口页");
  });
  it("rejects duplicate page and global widget identities before compilation", () => {
    const input = application(); input.pages.push(structuredClone(input.pages[0]!));
    expect(() => createDashboardDocument(input, input.pages[0]!.id)).toThrow("页面 ID");
    input.pages[1]!.id = "page-2";
    expect(() => createDashboardDocument(input, input.pages[0]!.id)).toThrow("节点 ID");
  });
  it("rejects unsupported envelopes and invalid existing authoring schema", () => {
    const input = application(), valid = createDashboardDocument(input, input.pages[0]!.id);
    for (const value of [{ ...valid, schemaVersion: 2 }, { ...valid, future: true }, { ...valid, application: { ...input, schemaVersion: 1 } }]) {
      expect(() => assertDashboardDocument(value)).toThrow();
    }
  });
});
