import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { BatteryIntelligencePanel } from "./BatteryIntelligencePanel";

vi.mock("../api", () => ({
  api: {
    listBatteryModelCatalog: vi.fn(),
    getBatteryReleaseGate: vi.fn(),
    predictBatteryFromFile: vi.fn(),
  },
}));

describe("BatteryIntelligencePanel", () => {
  it("presents production routing without claiming a static entry already executed", () => {
    const html = renderToStaticMarkup(<BatteryIntelligencePanel projectId="project-1" />);

    expect(html).toContain("读取发布门禁");
    expect(html).toContain("按原物理风险、动态稀疏路由和域外回退逻辑正式运行");
    expect(html).not.toContain("0 流量影子链");
  });
});
