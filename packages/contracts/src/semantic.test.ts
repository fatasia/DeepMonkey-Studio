import { describe, expect, it } from "vitest";
import { LEGACY_AGGREGATION_ALIASES, SEMANTIC_AGGREGATIONS } from "./semantic.js";

describe("semantic aggregation contract", () => {
  it("exposes the unified aggregation set", () => {
    expect(SEMANTIC_AGGREGATIONS).toEqual(["count", "countDistinct", "sum", "avg", "min", "max"]);
  });

  it("maps every dashboard aggregation value except none", () => {
    const dashboardAggregations = ["none", "count", "distinct-count", "sum", "average", "minimum", "maximum"] as const;
    for (const value of dashboardAggregations) {
      if (value === "none") continue;
      expect(LEGACY_AGGREGATION_ALIASES[value], value).toBeDefined();
    }
  });

  it("maps every pipeline aggregate operation", () => {
    const pipelineOperations = ["count", "sum", "average", "min", "max"] as const;
    for (const value of pipelineOperations) {
      expect(LEGACY_AGGREGATION_ALIASES[value], value).toBeDefined();
    }
  });

  it("maps every AskData aggregation operator", () => {
    const askDataOperators = ["count", "sum", "avg", "min", "max"] as const;
    for (const value of askDataOperators) {
      expect(LEGACY_AGGREGATION_ALIASES[value], value).toBeDefined();
    }
  });

  it("keeps every alias target inside the unified set", () => {
    for (const target of Object.values(LEGACY_AGGREGATION_ALIASES)) {
      expect(SEMANTIC_AGGREGATIONS).toContain(target);
    }
  });
});
