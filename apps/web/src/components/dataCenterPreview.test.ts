import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { DataDatasetPreview, DataDatasetRecord } from "@bim-studio/contracts";
import { loadDataCenterPreview } from "./dataCenterPreview";
const dataset: DataDatasetRecord = { id: "d", projectId: "p", connectionId: "c", name: "Rows", fields: [], refreshSeconds: 0, createdAt: "now", updatedAt: "now", writeback: { version: 1, recordPath: "/rows/{id}", fields: [{ key: "output", type: "number" }] } };
const result: DataDatasetPreview = { dataset: structuredClone(dataset), fields: [{ key: "output", label: "Output", type: "number" }], rows: [{ output: 12 }], durationMs: 10 };
describe("data center confirmed-write preview refresh", () => {
  it("reads fresh rows without metadata writes and retains unchanged writeback identity", async () => {
    const save = vi.fn();
    const loaded = await loadDataCenterPreview({ read: async () => result, save }, dataset, true, () => true);
    expect(loaded?.rows).toEqual([{ output: 12 }]); expect(save).not.toHaveBeenCalled();
    expect(loaded?.dataset.writeback).toBe(dataset.writeback);
  });
  it("ordinary query keeps schema discovery persistence", async () => {
    const save = vi.fn(async value => value);
    await loadDataCenterPreview({ read: async () => result, save }, dataset, false, () => true);
    expect(save).toHaveBeenCalledOnce();
  });
  it("failure is propagated for independent refresh feedback without replay", async () => {
    const read = vi.fn(async () => { throw new Error("503"); }), save = vi.fn();
    await expect(loadDataCenterPreview({ read, save }, dataset, true, () => true)).rejects.toThrow("503");
    expect(read).toHaveBeenCalledOnce(); expect(save).not.toHaveBeenCalled();
  });
  it("late cross-project or selection result cannot apply or save schema", async () => {
    const save = vi.fn();
    expect(await loadDataCenterPreview({ read: async () => result, save }, dataset, false, () => false)).toBeUndefined();
    expect(save).not.toHaveBeenCalled();
  });
  it("empty rows preserve known fields; explicit metadata save late result is discarded", async () => {
    const current = { ...dataset, fields: result.fields };
    const empty = await loadDataCenterPreview({ read: async () => ({ ...result, fields: [], rows: [] }), save: vi.fn() }, current, true, () => true);
    expect(empty?.fields).toEqual(current.fields);
    let active = true;
    expect(await loadDataCenterPreview({ read: async () => result, save: async value => { active = false; return value; } }, dataset, false, () => active)).toBeUndefined();
  });
  it("only scoped table/notice overrides use tokens in both themes", () => {
    const css = readFileSync(new URL("./DataCenterPreview.css", import.meta.url), "utf8");
    expect(css).not.toMatch(/#[\da-f]{3,8}\b/i);
    expect(css).toContain(".data-center-page .data-preview-table td { color: var(--text)");
    expect(css).toContain(".data-center-page .data-preview-empty strong { color: var(--text-strong)");
  });
});
