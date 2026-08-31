import { describe, expect, it } from "vitest";
import { behaviorUxFailures } from "./onlineFlowBehaviorUx.mjs";

const healthyAudit = {
  inspectorCollapsed: true,
  logsCollapsed: true,
  horizontalOverflow: false,
  smallText: [],
  smallTargets: [],
  headerOverlap: false,
  withinViewport: true,
  editorHeight: 480,
};

describe("behaviorUxFailures", () => {
  it("accepts a readable first view with progressive disclosure", () => {
    expect(behaviorUxFailures(healthyAudit)).toEqual([]);
  });

  it("reports density, readability and viewport regressions together", () => {
    const failures = behaviorUxFailures({
      ...healthyAudit,
      inspectorCollapsed: false,
      smallText: ["small=9px[目标]"],
      smallTargets: ["关闭"],
      headerOverlap: true,
    });

    expect(failures).toHaveLength(4);
    expect(failures.join(" ")).toContain("信息密度");
    expect(failures.join(" ")).toContain("9px");
    expect(failures.join(" ")).toContain("点击目标");
    expect(failures.join(" ")).toContain("重叠");
  });
});
