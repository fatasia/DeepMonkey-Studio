import { describe, expect, it, vi } from "vitest";
import type { ComponentRecord } from "../viewer/analysis";
import { createModelDiffSnapshotStore, diffHighlightEntries, diffIdentityOf, MAX_MODEL_DIFF_SNAPSHOTS, runModelDiff, snapshotLabel } from "./modelDiffReviewModel";

function record(modelId: string, stableSource: string, overrides: Partial<ComponentRecord> = {}): ComponentRecord {
  return {
    id: overrides.id ?? stableSource,
    stableId: `${modelId}:${stableSource}`,
    modelId,
    modelName: overrides.modelName ?? `模型 ${modelId}`,
    name: overrides.name ?? stableSource,
    type: "墙",
    path: `厂房/${stableSource}`,
    level: "一层",
    category: "墙",
    properties: overrides.properties ?? {},
    searchText: "",
    ...overrides,
  };
}

function snapshot(modelId: string, records: ComponentRecord[], capturedAt = "2026-09-19T08:00:00.000Z") {
  return { modelId, modelName: records[0]?.modelName ?? `模型 ${modelId}`, capturedAt, records };
}

describe("cross-instance diff identity", () => {
  it("strips the instance prefix so two loads of the same model align by source-stable id", () => {
    const before = record("instance-a", "ifc:1201", { id: "ifc:1201" });
    const after = record("instance-b", "ifc:1201", { id: "ifc:1201" });
    expect(diffIdentityOf(before)).toBe("ifc:1201");
    expect(diffIdentityOf(after)).toBe("ifc:1201");
  });

  it("diffs two instances as modified/unchanged instead of a full add+remove storm", () => {
    const before = snapshot("instance-a", [
      record("instance-a", "ifc:1"),
      record("instance-a", "ifc:2", { name: "原外墙" }),
    ]);
    const after = snapshot("instance-b", [
      record("instance-b", "ifc:2", { name: "外墙 B（改名）" }),
      record("instance-b", "ifc:3"),
    ]);
    const report = runModelDiff(before, after);
    expect(report.added.map((item) => item.id)).toEqual(["ifc:3"]);
    expect(report.removed.map((item) => item.id)).toEqual(["ifc:1"]);
    expect(report.modified.map((change) => change.after.name)).toEqual(["外墙 B（改名）"]);
    expect(report.summary.identityChanges).toBe(1);
  });

  it("keeps the original modelId/id on report records so 定位 still reaches the right instance", () => {
    const after = snapshot("instance-b", [record("instance-b", "ifc:3")]);
    const report = runModelDiff(snapshot("instance-a", []), after);
    const target = diffHighlightEntries(report)[0]!;
    expect(target).toEqual({ modelId: "instance-b", nodeId: "ifc:3", kind: "added" });
  });

  it("maps removed components onto the before instance and modified onto the after instance", () => {
    const report = runModelDiff(
      snapshot("instance-a", [record("instance-a", "ifc:1"), record("instance-a", "ifc:2")]),
      snapshot("instance-b", [record("instance-b", "ifc:2", { name: "改名" }), record("instance-b", "ifc:3")]),
    );
    const kinds = diffHighlightEntries(report).map((entry) => [entry.nodeId, entry.kind]);
    expect(kinds).toContainEqual(["ifc:1", "removed"]);
    expect(kinds).toContainEqual(["ifc:2", "modified"]);
    expect(kinds).toContainEqual(["ifc:3", "added"]);
  });

  it("strips instance metadata (root name, path prefix, runtime properties) so renames of an instance do not pollute every record", () => {
    const build = (modelId: string, sourceName: string, fireRating: string) => snapshot(modelId, [
      record(modelId, "root", { id: "root", name: sourceName, path: sourceName, properties: { modelId, layerNodeId: "root" } }),
      record(modelId, "ifc:1", { path: `${sourceName} / 厂房 / 外墙`, properties: { modelId, FireRating: fireRating } }),
    ]);
    const report = runModelDiff(build("instance-a", "厂房 v1.glb", "1h"), build("instance-b", "厂房 v2.glb", "2h"));
    expect(report.added).toHaveLength(0);
    expect(report.removed).toHaveLength(0);
    expect(report.modified).toHaveLength(1);
    expect(report.modified[0]!.changedFields).toEqual([
      { field: "properties.FireRating", kind: "property", before: "1h", after: "2h" },
    ]);
    expect(report.hasChanges).toBe(true);
  });
});

describe("model diff snapshot store", () => {
  it("notifies subscribers and returns the same snapshot reference until a mutation", () => {
    const store = createModelDiffSnapshotStore();
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    const first = store.getSnapshot();
    expect(first).toHaveLength(0);
    store.add(snapshot("instance-a", [record("instance-a", "ifc:1")]));
    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot()).not.toBe(first);
    expect(store.getSnapshot()).toBe(store.getSnapshot());
    unsubscribe();
    store.add(snapshot("instance-a", [record("instance-a", "ifc:2")]));
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("labels snapshots with model name and local capture time", () => {
    expect(snapshotLabel("厂房 v2", "2026-09-19T08:30:00.000Z")).toContain("厂房 v2 · ");
  });

  it("evicts the oldest snapshot beyond the session cap", () => {
    const store = createModelDiffSnapshotStore();
    for (let index = 0; index < MAX_MODEL_DIFF_SNAPSHOTS + 2; index += 1) {
      store.add(snapshot("instance-a", [record("instance-a", `ifc:${index}`)]));
    }
    expect(store.getSnapshot()).toHaveLength(MAX_MODEL_DIFF_SNAPSHOTS);
    expect(store.get("diff-snapshot-1")).toBeUndefined();
    expect(store.get("diff-snapshot-2")).toBeUndefined();
    expect(store.get(`diff-snapshot-${MAX_MODEL_DIFF_SNAPSHOTS + 2}`)).toBeDefined();
  });

  it("remove is a no-op for unknown ids", () => {
    const store = createModelDiffSnapshotStore();
    store.remove("missing");
    expect(store.getSnapshot()).toHaveLength(0);
  });
});
