import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { assessBatteryDataContract } from "@bim-studio/contracts";
import { BatteryDataContractStatus } from "./BatteryDataContractStatus";

describe("BatteryDataContractStatus", () => {
  it("shows actionable missing fields for an incompatible source", () => {
    const assessment = assessBatteryDataContract("bmsformer", [{ key: "temperature", type: "number" }]);
    const html = renderToStaticMarkup(<BatteryDataContractStatus assessment={assessment} />);

    expect(html).toContain("缺 5 项");
    expect(html).toContain("需补充 循环编号、采样时间、电压、电流、SOH 或放电容量");
    expect(html).not.toContain("可运行");
  });

  it("separates schema readiness from runtime cycle validation", () => {
    const assessment = assessBatteryDataContract("batterymformer", [
      "cycle", "time", "voltage", "current", "capacityAh", "chargeCapacityAh",
    ].map((key) => ({ key, type: "number" })));
    const html = renderToStaticMarkup(<BatteryDataContractStatus assessment={assessment} />);

    expect(html).toContain("可运行");
    expect(html).toContain("运行时继续校验早期循环数及每圈完整充放电采样");
  });
});
