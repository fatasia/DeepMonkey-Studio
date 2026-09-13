import { describe, expect, it } from "vitest";
import { parseAskDataQueryDraft } from "./draft.js";

describe("Ask Data AI draft parser", () => {
  it("accepts a fenced constrained plan", () => {
    expect(parseAskDataQueryDraft('```json\n{"datasetId":"telemetry","fields":["temperature"],"limit":20}\n```')).toMatchObject({ datasetId: "telemetry", fields: ["temperature"], limit: 20 });
  });

  it("rejects SQL or fields outside the contract", () => {
    expect(() => parseAskDataQueryDraft('{"datasetId":"telemetry","fields":["temperature"],"sql":"select *"}')).toThrow("不符合受限合同");
  });

  it("normalizes common function/alias aggregation names before strict validation", () => {
    expect(parseAskDataQueryDraft(JSON.stringify({
      datasetId: "telemetry",
      fields: ["device", "temperature"],
      groupBy: ["device"],
      aggregations: [{ function: "avg", field: "temperature", alias: "average_temperature" }],
    }))).toMatchObject({
      aggregations: [{ operator: "avg", field: "temperature", as: "average_temperature" }],
    });
  });
});
