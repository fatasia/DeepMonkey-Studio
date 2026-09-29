import { describe, expect, it } from "vitest";
import type { DataDatasetRecord, OntologyPackage } from "@bim-studio/contracts";
import {
  datasetSourceBinding,
  newActionDraft,
  newObjectDraft,
  newRelationDraft,
  objectPropertiesFromDataset,
  ONTOLOGY_ASSET_KINDS,
  ontologySaveErrors,
  ontologyStatusPresentation,
  ontologyUniqueKey,
  packageEditMode,
  summarizeGate,
} from "./ontologyWorkspaceLogic";

const dataset: DataDatasetRecord = {
  id: "ds-1", projectId: "p", connectionId: "c", name: "设备遥测", refreshSeconds: 1,
  fields: [
    { key: "device_id", label: "设备编号", type: "string" },
    { key: "temperature", label: "温度", type: "number" },
    { key: "recorded_at", label: "采集时间", type: "datetime" },
    { key: "mystery_column", label: "神秘列", type: "string" },
    { key: "line_id", label: "产线", type: "string" },
  ],
  createdAt: "2026-09-29T00:00:00.000Z", updatedAt: "2026-09-29T00:00:00.000Z",
};

describe("ontology workspace logic", () => {
  it("generates dataset candidates as unconfirmed with role suggestions (auto-identify never publishes)", () => {
    const candidates = objectPropertiesFromDataset(dataset);
    const byKey = new Map(candidates.map((item) => [item.key, item]));
    expect(candidates.every((item) => item.confirmed === false)).toBe(true);
    expect(byKey.get("device_id")?.suggestedRole).toBe("device");
    expect(byKey.get("temperature")?.type).toBe("number");
    expect(byKey.get("recorded_at")?.type).toBe("datetime");
    expect(byKey.get("mystery_column")?.suggestedRole).toBeUndefined();
    expect(byKey.get("line_id")?.suggestedRole).toBe("space");
  });

  it("builds a dataset source binding with the same schema fingerprint contract as the server", () => {
    const properties = objectPropertiesFromDataset(dataset);
    const binding = datasetSourceBinding(properties, dataset);
    expect(binding.kind).toBe("dataset");
    expect(binding.sourceId).toBe("ds-1");
    expect(binding.fieldMappings).toHaveLength(properties.length);
    expect(binding.schemaFingerprint).toMatch(/^[0-9a-f]+$/);
  });

  it("creates unique asset keys even after deletions", () => {
    expect(ontologyUniqueKey("object", [{ key: "object_1" }, { key: "object_3" }])).toBe("object_2");
    const pkg = { objects: [], relations: [], actions: [] } as unknown as OntologyPackage;
    const created = newObjectDraft(pkg);
    expect(created.key).toBe("object_1");
    expect(newRelationDraft(pkg).key).toBe("relation_1");
    expect(newActionDraft(pkg).key).toBe("action_1");
  });

  it("presents status with color tone, icon and text (triple encoding)", () => {
    expect(ontologyStatusPresentation("draft")).toMatchObject({ tone: "draft", icon: "PencilLine" });
    expect(ontologyStatusPresentation("review")).toMatchObject({ tone: "review", icon: "Eye" });
    expect(ontologyStatusPresentation("published")).toMatchObject({ tone: "published", icon: "CheckCircle2" });
    expect(ontologyStatusPresentation("retired")).toMatchObject({ tone: "retired", icon: "Archive" });
    expect(ONTOLOGY_ASSET_KINDS).toEqual(["objects", "relations", "actions"]);
  });

  it("summarizes the nine-gate report into pass count and failed details", () => {
    const gates: Array<{ gateId: number; label: string; passed: boolean; errors: string[] }> = Array.from(
      { length: 9 },
      (_, index) => ({ gateId: index + 1, label: `g${index + 1}`, passed: true, errors: [] as string[] }),
    );
    expect(summarizeGate({ ok: true, gates, errors: [] })).toMatchObject({ passed: 9, total: 9, failedGates: [] });
    gates[2]!.passed = false;
    gates[2]!.errors = ["能力不存在"];
    const summary = summarizeGate({ ok: false, gates, errors: ["能力不存在"] });
    expect(summary.passed).toBe(8);
    expect(summary.failedGates).toEqual([{ gateId: 3, label: "g3", errors: ["能力不存在"] }]);
  });

  it("splits server-side semicolon errors and classifies edit mode", () => {
    expect(ontologySaveErrors(new Error("主键缺失；来源缺失"))).toEqual(["主键缺失", "来源缺失"]);
    expect(packageEditMode("draft")).toBe("editable");
    expect(packageEditMode("review")).toBe("editable");
    expect(packageEditMode("published")).toBe("readonly");
    expect(packageEditMode("retired")).toBe("readonly");
  });
});
