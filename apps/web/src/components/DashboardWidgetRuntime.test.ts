import { describe, expect, it } from "vitest";
import { mergeProductMetrics } from "./dashboardMetrics";

describe("mergeProductMetrics", () => {
  it("uses the same product.field metric key for pipeline and dataset outputs", () => {
    const rows = [{ cycle_time: 12.4 }, { cycle_time: 13.1 }];
    const metrics = mergeProductMetrics({}, "pipeline-cycle", [{ key: "cycle_time", label: "节拍", type: "number", unit: "s" }], rows);

    expect(metrics["pipeline-cycle.cycle_time"]).toMatchObject({
      value: 12.4,
      rows,
      samples: [{ value: 13.1 }, { value: 12.4 }]
    });
  });
});
