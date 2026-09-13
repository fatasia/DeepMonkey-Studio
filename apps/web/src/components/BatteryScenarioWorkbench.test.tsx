import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BatteryScenarioWorkbench } from "./BatteryScenarioWorkbench";

describe("BatteryScenarioWorkbench", () => {
  it("exposes editable initial state and multi-segment operating conditions", () => {
    const html = renderToStaticMarkup(<BatteryScenarioWorkbench
      projectId="project-1"
      chemistry="lfp"
      nominalCapacityAh={100}
      nativeRuntime
    />);
    expect(html).toContain("可编辑工况推演");
    expect(html).toContain("初始 SOC %");
    expect(html).toContain("电流倍率 C");
    expect(html).toContain("正值充电 / 负值放电");
    expect(html).toContain("运行多物理推演");
    expect(html).not.toContain("disabled=\"\"");
  });

  it("disables simulation while the Rust twin runtime is unavailable", () => {
    const html = renderToStaticMarkup(<BatteryScenarioWorkbench
      projectId="project-1"
      chemistry="lfp"
      nominalCapacityAh={100}
      nativeRuntime={false}
    />);
    expect(html).toContain("运行时未连接");
    expect(html).toContain("disabled=\"\"");
  });
});
