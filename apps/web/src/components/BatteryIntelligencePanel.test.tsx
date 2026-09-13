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

    expect(html).toContain("读取模型目录");
    expect(html).toContain("SPM-PINO 多物理神经算子");
    expect(html).toContain("TwinMoE 风险路由");
    expect(html).toContain("在线状态同化");
    expect(html).toContain("CLF-CBF 影子投影");
    expect(html).toContain("Rust · ONNX Runtime");
    expect(html).toContain("内置样例");
    expect(html).toContain("LFP 大容量工程");
    expect(html).toContain("LFP 280 Ah 老化");
    expect(html).toContain("96 电芯 Pack");
    expect(html).not.toContain("运行示例");
    expect(html).toMatch(/class="button primary"[^>]*>.*评估 SOH/s);
    expect(html).not.toContain("按原物理风险、动态稀疏路由和域外回退逻辑正式运行");
    expect(html).not.toContain("0 流量影子链");
  });
});
