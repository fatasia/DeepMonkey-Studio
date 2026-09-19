import { describe, expect, it } from "vitest";
import type { ComponentRecord } from "./analysis";
import { diffComponentSets } from "./modelDiff";

function record(overrides: Partial<ComponentRecord> & { stableId: string }): ComponentRecord {
  return {
    id: overrides.stableId,
    modelId: "model-1",
    modelName: "厂房 RVT",
    name: overrides.stableId,
    type: "墙",
    path: "厂房/一层",
    level: "一层",
    category: "墙",
    specialty: "建筑",
    properties: {},
    searchText: "",
    ...overrides,
  };
}

describe("model version diff (P1 slice)", () => {
  it("classifies added, removed and modified components by stableId", () => {
    const before = [record({ stableId: "wall-1" }), record({ stableId: "wall-2" }), record({ stableId: "door-1" })];
    const after = [
      record({ stableId: "wall-1" }),
      record({ stableId: "wall-2", name: "外墙 B（改名）" }),
      record({ stableId: "door-2", name: "新门洞" }),
    ];
    const report = diffComponentSets(before, after);
    expect(report.added.map((r) => r.stableId)).toEqual(["door-2"]);
    expect(report.removed.map((r) => r.stableId)).toEqual(["door-1"]);
    expect(report.modified).toHaveLength(1);
    expect(report.modified[0]?.changedFields).toEqual([
      { field: "name", kind: "identity", before: "wall-2", after: "外墙 B（改名）" },
    ]);
    expect(report.summary).toMatchObject({ addedCount: 1, removedCount: 1, modifiedCount: 1, identityChanges: 1 });
    expect(report.hasChanges).toBe(true);
  });

  it("reports property-level field diffs", () => {
    const before = [record({ stableId: "wall-1", properties: { FireRating: "1h", Material: "混凝土" } })];
    const after = [record({ stableId: "wall-1", properties: { FireRating: "2h" } })];
    const report = diffComponentSets(before, after);
    const change = report.modified[0]!;
    expect(change.changedFields).toEqual([
      { field: "properties.FireRating", kind: "property", before: "1h", after: "2h" },
      { field: "properties.Material", kind: "property", before: "混凝土", after: "" },
    ]);
    expect(report.summary.propertyChanges).toBe(2);
  });

  it("treats semantic fields separately from identity", () => {
    const before = [record({ stableId: "wall-1", category: "墙", specialty: "建筑" })];
    const after = [record({ stableId: "wall-1", category: "结构墙", specialty: "结构" })];
    const report = diffComponentSets(before, after);
    expect(report.modified[0]?.changedFields.every((field) => field.kind === "semantic")).toBe(true);
    expect(report.summary.semanticChanges).toBe(2);
  });

  it("reports an honest empty diff", () => {
    const same = [record({ stableId: "wall-1" })];
    const report = diffComponentSets(same, same.map((r) => ({ ...r })));
    expect(report.hasChanges).toBe(false);
    expect(report.unchangedCount).toBe(1);
    expect(report.added).toHaveLength(0);
    expect(report.removed).toHaveLength(0);
    expect(report.modified).toHaveLength(0);
  });
});
