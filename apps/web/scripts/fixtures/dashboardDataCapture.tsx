import React from "react";
import { createRoot } from "react-dom/client";
import { DashboardReportTable } from "../../src/components/DashboardWidgetVisualization";
import { DashboardWidgetView } from "../../src/components/DashboardWidgetRuntime";
import { captureRenderedDashboardData } from "../../src/delivery/captureRenderedDashboardData";
import "../../src/styles/base.css";
import "../../src/styles/platform-components.css";
import "../../src/styles/dashboard-workspace.css";

const common = { key: "capture", title: "产量", unit: "件", source: "sample", color: "#ffffff" };
const metric = { value: 42, samples: [], rows: [{ name: "甲", count: 42 }, { name: "乙", count: 19 }] };
const none = () => {};
createRoot(document.getElementById("root")!).render(<>
  <section style={{ width: 320, height: 120 }}><DashboardWidgetView locale="zh-CN" compact={false}
    widget={{ ...common, type: "value" } as never} metric={metric} onDataInteraction={none}
    onAnimationStart={none} onAnimationEnd={none} /></section>
  <section style={{ width: 460, height: 240 }}><DashboardReportTable locale="zh-CN" compact={false}
    widget={{ ...common, type: "table", report: { pageSize: 8, showRowNumbers: true, freezeFirstColumn: true } } as never}
    metric={metric} onDataInteraction={none} /></section>
  <section style={{ width: 460, height: 240 }}><DashboardReportTable locale="zh-CN" compact={false}
    widget={{ ...common, type: "table", report: { pageSize: 1, showRowNumbers: true } } as never}
    metric={metric} onDataInteraction={none} /></section>
</>);
Object.assign(globalThis, { captureWidget: (kind: string, index = 0) => {
  const root = document.querySelectorAll<HTMLElement>(`[data-dashboard-capture="${kind}"]`)[index]!;
  const rect = root.getBoundingClientRect();
  return captureRenderedDashboardData(root, { logicalSize: [rect.width, rect.height], resolveFonts: () => ["font.frozen"] });
} });
