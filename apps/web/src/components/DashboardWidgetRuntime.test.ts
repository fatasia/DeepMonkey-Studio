import { describe, expect, it } from "vitest";
import { mergeDirectBindingMetric, mergeProductMetrics } from "./dashboardMetrics";

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

describe("direct binding dashboard metrics", () => {
  it("writes a gateway value under the widget key and preserves rows for table widgets", () => {
    const rows = [{ temperature: 28.2 }, { temperature: 27.9 }];
    const metrics = mergeDirectBindingMetric({}, "device.temperature", 28.2, rows, 1_700_000_000_000);

    expect(metrics["device.temperature"]).toEqual({
      value: 28.2,
      samples: [{ time: 1_700_000_000_000, value: 28.2 }],
      rows
    });
  });
});
