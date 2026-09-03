import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { WorkcellPlanningSetup } from "./WorkcellPlanningSetup";
import { starterWorkcellScenePlanningParameters } from "./workcellAuditModel";

describe("WorkcellPlanningSetup", () => {
  it("makes all scene-derived starter values visible before confirmation", () => {
    const html = renderToStaticMarkup(<WorkcellPlanningSetup
      value={starterWorkcellScenePlanningParameters()}
      trajectoryCount={2}
      resultVisible={false}
      disabled={false}
      onChange={vi.fn()}
    />);

    expect(html).toContain("系统起步值尚未确认");
    expect(html).toContain("安全间隙");
    expect(html).toContain("候选 TCP 速度");
    expect(html).toContain("TCP 包络半径");
    expect(html).toContain("确认用于本次验证");
  });

  it("shows the confirmed basis without exposing irrelevant trajectory fields", () => {
    const value = { ...starterWorkcellScenePlanningParameters(), status: "engineer-confirmed" as const };
    const html = renderToStaticMarkup(<WorkcellPlanningSetup
      value={value}
      trajectoryCount={0}
      resultVisible
      disabled={false}
      onChange={vi.fn()}
    />);

    expect(html).toContain("规划基准已确认");
    expect(html).not.toContain("候选 TCP 速度");
    expect(html).toContain("当前场景未形成机器人直线候选轨迹");
  });
});
