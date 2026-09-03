import { describe, expect, it } from "vitest";
import { datasetSchemaChanged } from "./datasetSchema";

describe("datasetSchemaChanged", () => {
  it("detects fields discovered by the latest query", () => {
    expect(datasetSchemaChanged([], [{ key: "temperature", label: "temperature", type: "number" }])).toBe(true);
  });

  it("keeps a stable schema without an unnecessary metadata write", () => {
    const fields = [{ key: "temperature", label: "温度", type: "number" as const, unit: "°C" }];
    expect(datasetSchemaChanged(fields, fields.map((field) => ({ ...field })))).toBe(false);
  });
});
