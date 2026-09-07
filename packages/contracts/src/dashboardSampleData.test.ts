import { describe, expect, it } from "vitest";
import { assertDashboardSampleData } from "./dashboardSampleData.js";
import { assertApplicationDocument, type ApplicationDocument } from "./application.js";
import { migrateSceneSnapshotV1 } from "./applicationMigration.js";
import fixture from "../../../test-fixtures/scene-v1-pure-3d.json";
import type { SceneSnapshot } from "./scene.js";

function application(sampleData: unknown): ApplicationDocument {
  const document = migrateSceneSnapshotV1(fixture as SceneSnapshot);
  document.pages[0]!.nodes.push({ id: "sample", kind: "data-widget", frame: { x: 0, y: 0, width: 200, height: 150 }, zIndex: 1,
    widget: { type: "value", title: "示例", key: "sample", unit: "", sampleData: sampleData as never } });
  return document;
}
describe("authored dashboard samples", () => {
  it("accepts finite scalars, empty rows and serializable snapshots", () => {
    for (const rows of [[], [{ value: 0, text: "设备", active: false, missing: null }]]) {
      expect(() => assertApplicationDocument(application({ rows }))).not.toThrow();
    }
  });
  it.each([null, { rows: Array.from({ length: 101 }, () => ({})) }, { rows: [{ value: Infinity }] }, { rows: [{ value: [] }] },
    { rows: [{ value: "a".repeat(513) }] }, { rows: [Object.fromEntries(Array.from({ length: 17 }, (_, i) => [String(i), 0]))] },
    { rows: [JSON.parse('{"__proto__":1}')] }, { rows: [] , sourceId: "" }])("rejects malformed or oversized samples: %j", value => {
    expect(() => assertDashboardSampleData(value)).toThrow();
    expect(() => assertApplicationDocument(application(value))).toThrow();
  });
  it("rejects competing sources", () => {
    for (const patch of [{ datasetId: "data" }, { pipelineId: "pipe" }]) {
      const doc = application({ rows: [] }); const node = doc.pages[0]!.nodes.at(-1)!;
      if (node.kind === "data-widget") Object.assign(node.widget, patch);
      expect(() => assertApplicationDocument(doc)).toThrow(/最多只能/);
    }
  });
});
