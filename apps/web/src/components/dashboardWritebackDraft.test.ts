import { describe, expect, it } from "vitest";
import type { DataWritebackConfig } from "@bim-studio/contracts";
import { createWritebackDraft, prepareWritebackDraft, writebackConflicts } from "./dashboardWritebackDraft";

const config: DataWritebackConfig = { version: 1, recordPath: "/records/{id}", fields: [
  { key: "count", type: "number", required: true, min: 0, max: 100 },
  { key: "active", type: "boolean", required: true }, { key: "date", type: "date" },
] };
describe("business writeback draft", () => {
  it("retains zero and false without treating them as missing", () => {
    const draft = createWritebackDraft(config, { version: '"1"', values: { count: 0, active: false } });
    expect(draft).toEqual({ count: "0", active: "false", date: "" });
    expect(prepareWritebackDraft(config, draft)).toEqual({ values: { count: 0, active: false, date: null }, issues: [] });
  });
  it("validates before confirmation and does not erase invalid user input", () => {
    const draft = { count: "12x", active: "yes", date: "2026-02-30" };
    expect(prepareWritebackDraft(config, draft).issues.map(issue => issue.field)).toEqual(["count", "active", "date"]);
    expect(draft.count).toBe("12x");
    expect(prepareWritebackDraft(config, { count: "", active: "false" }).issues[0]?.field).toBe("count");
    expect(prepareWritebackDraft(config, { count: "   ", active: "false" }).issues[0]?.field).toBe("count");
  });
  it("compares conflicts without automatically overwriting local or remote values", () => {
    const baseline = { version: '"1"', values: { count: 5, active: false } };
    const current = { version: '"2"', values: { count: 8, active: false } };
    expect(writebackConflicts(config, baseline, current, { count: "6", active: "false" })).toEqual([{ key: "count", before: 5, local: 6, current: 8 }]);
    expect(baseline.values.count).toBe(5); expect(current.values.count).toBe(8);
  });
});
