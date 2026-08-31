import { describe, expect, it } from "vitest";
import type { DataConnectionRecord, DataDatasetRecord } from "@bim-studio/contracts";
import { PARAMETRIC_CAD_TEMPLATES } from "./templates.js";
import { assertParametricBindingReferences, listParametricBindingSources } from "./bindings.js";

const connection = (id: string, type: DataConnectionRecord["type"]): DataConnectionRecord => ({
  id, projectId: "project-1", name: id, type, enabled: true, config: {}, createdAt: "now", updatedAt: "now"
});
const dataset = (id: string, connectionId: string, field = "temperature"): DataDatasetRecord => ({
  id, projectId: "project-1", connectionId, name: id, refreshSeconds: 1,
  fields: [{ key: field, label: field, type: "number", unit: "°C" }], createdAt: "now", updatedAt: "now"
});

describe("parametric runtime bindings", () => {
  it("classifies simulation, device and dataset fields without exposing connection config", () => {
    const sources = listParametricBindingSources({
      dataConnections: [connection("sim", "simulation"), connection("plc", "opcua"), connection("db", "postgresql")],
      datasets: [dataset("sim-data", "sim"), dataset("plc-data", "plc"), dataset("db-data", "db")]
    });
    expect(sources.map((source) => source.target.kind)).toEqual(["dataset-field", "device-point", "simulation-signal"]);
    expect(JSON.stringify(sources)).not.toContain("config");
  });

  it("rejects stale project references before persistence", () => {
    const context = { dataConnections: [connection("sim", "simulation")], datasets: [dataset("signals", "sim", "stroke")] };
    const definition = structuredClone(PARAMETRIC_CAD_TEMPLATES[0]!.definition);
    definition.semanticBindings![0]!.target = listParametricBindingSources(context)[0]!.target;
    expect(() => assertParametricBindingReferences(definition, context)).not.toThrow();
    expect(() => assertParametricBindingReferences(definition, { ...context, datasets: [] })).toThrow("运行绑定已失效");
  });
});
