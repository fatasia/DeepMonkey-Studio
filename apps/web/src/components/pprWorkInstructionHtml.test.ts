import { describe, expect, it } from "vitest";
import type { PprWorkInstructionPreview } from "@bim-studio/ppr-lite-engine";
import { pprWorkInstructionFileName, renderPprWorkInstructionHtml } from "./pprWorkInstructionHtml";

describe("PPR work instruction offline HTML", () => {
  it("creates a self-contained print document and escapes authored content", () => {
    const preview: PprWorkInstructionPreview = {
      planName: "总装 <A>",
      totalStepCount: 1,
      totalQualityControlCount: 1,
      operations: [{
        sequence: 2,
        operationId: "assemble",
        operationName: "装配 & 紧固",
        standardTimeMinutes: 4.5,
        steps: [{ id: "step-1", instruction: "紧固 <script>alert(1)</script>" }],
        safetyNotes: [{ id: "safety-1", note: "远离夹紧区" }],
        qualityChecks: [{
          id: "quality-1",
          checkpoint: "扭矩",
          specificationKind: "tolerance",
          targetValue: 12,
          tolerance: 1,
          unit: "N·m",
          inspectionMethod: "校准扭矩枪",
          samplingFrequency: { mode: "every-n-items", interval: 20 },
          outOfControlReaction: "停线并隔离本批",
        }],
        visualReferences: [{ kind: "object", id: "fixture-01" }],
      }],
    };

    const html = renderPprWorkInstructionHtml(preview, { documentLabel: "v2", generatedAt: "2026-09-03 16:30" });
    expect(html).toContain("<!doctype html>");
    expect(html).toContain("@media print");
    expect(html).toContain("charset=\"utf-8\"");
    expect(html).toContain("总装 &lt;A&gt;");
    expect(html).toContain("紧固 &lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("fixture-01");
    expect(html).toContain("12 ± 1 N·m");
    expect(html).toContain("校准扭矩枪");
    expect(html).toContain("每 20 件");
    expect(html).toContain("停线并隔离本批");
    expect(html).toContain("不代表量测采集、SPC");
  });

  it("produces a Windows-safe HTML file name", () => {
    expect(pprWorkInstructionFileName('总装: A/B*计划. ')).toBe("总装_ A_B_计划-EWI.html");
  });
});
