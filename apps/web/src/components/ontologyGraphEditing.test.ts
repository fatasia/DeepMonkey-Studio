import { describe, expect, it } from "vitest";
import { newOntologyPackage, type OntologyPackage } from "@bim-studio/contracts";
import { applyGraphRelation, graphRelationDraft } from "./ontologyGraphEditing";

function pkg(): OntologyPackage {
  const result = newOntologyPackage("manufacturing", "admin", "2026-10-07T00:00:00.000Z");
  result.id = "package"; result.name = "设备本体";
  result.objects = ["Device", "Sensor", "Alarm"].map((key, index) => ({ id: `object-${index}`, key, label: key,
    domain: "manufacturing", primaryKeys: [index ? "id" : "device_id"], properties: [{ key: index ? "id" : "device_id", label: "编号", type: "string", confirmed: true }],
    sourceBindings: [], aliases: [], identityMappings: [], status: "draft", version: 1, owner: "admin" }));
  result.relations = [{ id: "relation-existing", key: "has_sensor", label: "包含传感器", sourceObject: "Device", targetObject: "Sensor",
    cardinality: "one-to-many", direction: "directed", properties: [], keyMapping: { sourceField: "device_id", targetField: "id" },
    source: { kind: "manual", note: "资产台账引用" }, evidence: [{ source: "设备台账", sampleCount: 20, recordedAt: "2026-10-07T00:00:00.000Z" }], status: "draft", version: 1 }];
  return result;
}

describe("ontology graph relation authoring", () => {
  it("creates a configurable draft with distinct key, without modifying the package", () => {
    const original = pkg();
    const relation = graphRelationDraft(original, "object:Sensor", "object:Alarm");
    expect(relation).toMatchObject({ sourceObject: "Sensor", targetObject: "Alarm", status: "draft", evidence: [], keyMapping: { sourceField: "", targetField: "" } });
    expect(original.relations).toHaveLength(1);
    expect(relation.id).not.toBe(original.relations[0]!.id);
  });
  it("keeps identity, evidence and valid mapping when reconnecting an existing relation", () => {
    const original = pkg();
    const relation = graphRelationDraft(original, "object:Device", "object:Alarm", "has_sensor");
    expect(relation.id).toBe("relation-existing");
    expect(relation.evidence).toEqual(original.relations[0]!.evidence);
    expect(relation.keyMapping).toEqual({ sourceField: "device_id", targetField: "id" });
    const updated = applyGraphRelation(original, relation);
    expect(updated.relations).toHaveLength(1);
    expect(updated.relations[0]!.targetObject).toBe("Alarm");
    expect(original.relations[0]!.targetObject).toBe("Sensor");
    expect(updated.objects).toBe(original.objects);
  });
  it("clears only the invalid side of a field mapping after changing endpoints", () => {
    const relation = graphRelationDraft(pkg(), "object:Sensor", "object:Alarm", "has_sensor");
    expect(relation.keyMapping).toEqual({ sourceField: "", targetField: "id" });
  });
  it.each([["dataset:metrics", "object:Device"], ["object:Device", "action:diagnose"], ["cluster:manufacturing", "object:Device"], ["object:missing", "object:Device"]])("rejects invalid relation ports %s → %s", (source, target) => {
    expect(() => graphRelationDraft(pkg(), source, target)).toThrow();
  });
  it("fails if a relation being reconnected has been removed", () => {
    expect(() => graphRelationDraft(pkg(), "object:Device", "object:Sensor", "removed")).toThrow("原关系");
  });
  it("allows self relations and parallel semantic relations as distinct contracts", () => {
    const original = pkg();
    const relation = graphRelationDraft(original, "object:Device", "object:Device");
    relation.source.note = "设备递归层级";
    expect(applyGraphRelation(original, relation).relations).toHaveLength(2);
  });
  it("requires rationale and rejects duplicate keys before writing", () => {
    const original = pkg();
    const relation = graphRelationDraft(original, "object:Sensor", "object:Alarm");
    expect(() => applyGraphRelation(original, relation)).toThrow("建立理由");
    relation.source.note = "台账"; relation.key = "has_sensor";
    expect(() => applyGraphRelation(original, relation)).toThrow("标识已存在");
  });
});
