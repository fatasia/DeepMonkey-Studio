import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { PlantLiteStudyRecord } from "@bim-studio/contracts";
import { PlantLiteWorkforceEvidence } from "./PlantLiteWorkforceEvidence";

describe("PlantLiteWorkforceEvidence", () => {
  it("reports headcount, shifts, shared stations and measured utilization only", () => {
    const result = {
      model: {
        id: "line", name: "产线",
        resources: [{ id: "workers", name: "装配班组", kind: "worker", capacity: 3, availability: { shifts: [{ startMinute: 360, endMinute: 840 }] } }],
        nodes: [
          { id: "a", name: "装配", kind: "station", processingTime: { kind: "deterministic", value: 2 }, workerResourceId: "workers" },
          { id: "b", name: "检验", kind: "station", processingTime: { kind: "deterministic", value: 1 }, workerResourceId: "workers" },
        ],
        edges: [],
      },
      outcome: {
        resourceUtilization95: { workers: { mean: .75, lower95: .7, upper95: .8, sampleStandardDeviation: .04, samples: 12 } },
      },
    } as unknown as PlantLiteStudyRecord;

    const html = renderToStaticMarkup(<PlantLiteWorkforceEvidence result={result} />);
    expect(html).toContain("人工资源");
    expect(html).toContain("3 人 · 1 班 · 480 分/日");
    expect(html).toContain("计划利用率 75.0% · 95% CI 70.0%–80.0%");
    expect(html).toContain("2 个工位共享：装配、检验");
    expect(html).not.toContain("故障");
    expect(html).not.toContain("能耗");
    expect(html).not.toContain("人体工学");
  });

  it("stays hidden for legacy studies without worker pools", () => {
    const result = { model: { resources: [] } } as unknown as PlantLiteStudyRecord;
    expect(renderToStaticMarkup(<PlantLiteWorkforceEvidence result={result} />)).toBe("");
  });
});
