import { describe, expect, it } from "vitest";
import { assertApplicationDocument, type ApplicationDocument } from "./application.js";
import { migrateSceneSnapshotV1 } from "./applicationMigration.js";
import type { SceneSnapshot } from "./index.js";
import fixture from "../../../test-fixtures/scene-v1-pure-3d.json";

function document(patch: Record<string, unknown> = {}): ApplicationDocument {
  const application = migrateSceneSnapshotV1(fixture as SceneSnapshot);
  application.pages[0]!.nodes.push({ id: "entry", kind: "data-widget", frame: { x: 0, y: 0, width: 600, height: 540 }, zIndex: 2,
    widget: { title: "填报", type: "record-form", key: "record.form", unit: "", datasetId: "dataset", recordForm: { recordId: "订单_01" }, ...patch } });
  return application;
}
describe("record-form document contract", () => {
  it("round trips a fixed saved dataset target and unfinished author configuration", () => {
    expect(() => assertApplicationDocument(JSON.parse(JSON.stringify(document())))).not.toThrow();
    expect(() => assertApplicationDocument(document({ datasetId: "", recordForm: { recordId: "" } }))).not.toThrow();
  });
  it.each(["../record", "id?x=1", "x".repeat(129), 12, null])("rejects invalid record ID %s", recordId => {
    expect(() => assertApplicationDocument(document({ recordForm: { recordId } }))).toThrow();
  });
  it("does not accept embedded target URL or client-controlled credentials/permission", () => {
    for (const key of ["url", "canWrite", "credentials", "expectedVersion"]) expect(() => assertApplicationDocument(document({ recordForm: { recordId: "a", [key]: "x" } }))).toThrow();
  });
  it.each(["pipelineId", "directBinding", "sampleData", "semanticBinding"])("rejects alternative source %s", key => {
    expect(() => assertApplicationDocument(document({ [key]: key === "pipelineId" ? "pipeline" : {} }))).toThrow();
  });
});
