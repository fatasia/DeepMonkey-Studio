import { describe, expect, it } from "vitest";
import { degradedRendererCapabilities, rendererCapabilityContextSummary, rendererCapabilityRowLabel, rendererCapabilityRows } from "./rendererCapabilityUserFace";

describe("K17 渲染能力清单用户面", () => {
  it("行数据单源自 contracts 登记表:降级/缺席排序在前,id 唯一", () => {
    const rows = rendererCapabilityRows();
    expect(rows.length).toBeGreaterThanOrEqual(10);
    expect(new Set(rows.map(row => row.id)).size).toBe(rows.length);
    const supports = rows.map(row => row.support);
    const firstSupported = supports.indexOf("supported");
    expect(supports.slice(firstSupported).every(value => value === "supported")).toBe(true);
    for (const row of rows) expect(row.evidence).toMatch(/\.(ts|rs|wgsl|json)/);
  });

  it("degraded 与全表口径一致;受限项标签双语", () => {
    const degraded = degradedRendererCapabilities();
    expect(degraded.every(row => row.support !== "supported")).toBe(true);
    const anyRow = degraded[0] ?? rendererCapabilityRows()[0]!;
    expect(rendererCapabilityRowLabel(anyRow, "zh-CN")).toContain("·");
    expect(rendererCapabilityRowLabel(anyRow, "en-US")).toMatch(/Full|Degraded|Unavailable/);
  });

  it("AI/Harness 上下文摘要:全完整与有限受两种口径,受限项逐一点名", () => {
    const summary = rendererCapabilityContextSummary("zh-CN");
    const degraded = degradedRendererCapabilities();
    if (degraded.length === 0) expect(summary).toContain("全部能力完整");
    else for (const row of degraded) expect(summary).toContain(row.title);
    const summaryEn = rendererCapabilityContextSummary("en-US");
    expect(summaryEn).toMatch(/Renderer capabilities/);
  });
});
