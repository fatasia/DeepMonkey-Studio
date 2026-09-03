import type { WorkcellRobotLoadCheck } from "@bim-studio/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { WorkcellLoadEvidence } from "./WorkcellLoadEvidence";

describe("WorkcellLoadEvidence", () => {
  it("shows measured planning evidence and preserves missing data explicitly", () => {
    const complete: WorkcellRobotLoadCheck = {
      robotId: "robot-1", toolObjectId: "tool-1", status: "within-planning-envelope",
      violations: [], missingFields: [], ratedPayloadKg: 20, totalLoadKg: 12, payloadUtilization: .6,
      maximumLoadCenterDistanceMeters: .35, loadCenterDistanceMeters: .2, loadCenterUtilization: .57,
      tcpOffsetDistanceMeters: .25, evidenceCoverage: 1, capabilitySource: "configured-prefab",
      capabilityReference: "robot.articulated-6@1.0.0", toolLoadSource: "author-confirmed", declaration: "仅做规划筛查。",
    };
    const missing: WorkcellRobotLoadCheck = {
      robotId: "robot-2", status: "needs-data", violations: [],
      missingFields: ["tool-binding", "rated-payload", "tcp-position"], evidenceCoverage: .2,
      declaration: "未提供数据时不输出通过结论。",
    };
    const html = renderToStaticMarkup(<WorkcellLoadEvidence checks={[complete, missing]} />);

    expect(html).toContain("负载与 TCP 规划筛查");
    expect(html).toContain("12 kg");
    expect(html).toContain("60.0%");
    expect(html).toContain("robot.articulated-6@1.0.0");
    expect(html).toContain("末端工具绑定、额定负载、TCP 位置");
    expect(html).toContain("需要补充数据");
    expect(html).not.toContain("<dd>0 kg</dd>");
  });
});
