import React from "react";
import { createRoot } from "react-dom/client";
import { DashboardWidgetView, widgetBackgroundStyle } from "../components/DashboardWidgetRuntime";
import { dashboardAuthoredTypography } from "../components/dashboardTemplateTypography";
import { dashboardWidgetTextColor } from "../components/dashboardWidgetTextColor";
import { captureRenderedDashboardData } from "./captureRenderedDashboardData";
import { dashboardFrozenFontStyle } from "./dashboardFrozenFontStyle";
import "../styles/base.css";
import "../styles/platform-components.css";
import "../styles/dashboard-workspace.css";
import "../components/DashboardTemplateTypography.css";

interface LayoutRequest {
  widget: React.ComponentProps<typeof DashboardWidgetView>["widget"];
  metric: React.ComponentProps<typeof DashboardWidgetView>["metric"];
  locale: "zh-CN" | "en-US";
  width: number;
  height: number;
  fonts: { id: string; base64: string }[];
}
declare global {
  // Only the startup-owned capture process injects this request.
  var __DASHBOARD_LAYOUT_REQUEST__: LayoutRequest;
  var __DASHBOARD_LAYOUT_ERROR__: string | undefined;
  var captureDashboardHeading: (() => unknown) | undefined;
}

const request = globalThis.__DASHBOARD_LAYOUT_REQUEST__;
const none = () => {};
try {
  if (!request.fonts.length) throw new Error("Frozen heading fonts are required");
  const families = request.fonts.map((font, index) => {
    const bytes = Uint8Array.from(atob(font.base64), character => character.charCodeAt(0));
    return { ...font, bytes, family: `FrozenDashboardFont${index}`, ...dashboardFrozenFontStyle(bytes) };
  });
  for (const font of families) {
    const face = new FontFace(font.family, font.bytes.buffer, { weight: String(font.weight), style: font.style });
    await face.load();
    document.fonts.add(face);
  }
  await document.fonts.ready;
  const fontFamily = families.map(font => font.family).join(", ");
  createRoot(document.getElementById("root")!).render(
    <section id="heading-node" className={`dashboard-node dashboard-native-widget ${request.widget.fontSize ? "authored-typography" : ""}`}
      style={{ width: request.width, height: request.height, fontFamily,
        ...widgetBackgroundStyle(request.widget), ...dashboardAuthoredTypography(request.widget), color: dashboardWidgetTextColor(request.widget) }}>
      <DashboardWidgetView widget={request.widget} metric={request.metric} locale={request.locale}
        compact={false} onDataInteraction={none} onAnimationStart={none} onAnimationEnd={none} />
    </section>);
  globalThis.captureDashboardHeading = () => {
    const root = document.querySelector<HTMLElement>('[data-dashboard-capture="chart"]');
    if (!root) throw new Error("Frozen chart has not mounted");
    for (const element of root.querySelectorAll<HTMLElement>("[data-capture-role]")) {
      const style = getComputedStyle(element);
      const matches = families.filter(font => font.weight === Number(style.fontWeight) && font.style === style.fontStyle);
      if (!matches.length) throw new Error("Frozen fonts do not contain the measured heading weight/style");
      element.style.fontFamily = matches.map(font => font.family).join(", ");
      element.style.fontSynthesis = "none";
    }
    return captureRenderedDashboardData(root, {
      logicalSize: [request.width, request.height],
      geometryRoot: document.getElementById("heading-node")!,
      resolveFonts: style => {
        const actual = style.fontFamily.replaceAll('"', "").replaceAll("'", "").split(",").map(value => value.trim());
        const matching = families.filter(font => font.weight === Number(style.fontWeight) && font.style === style.fontStyle);
        if (actual.join(",") !== matching.map(font => font.family).join(","))
          throw new Error("Measured heading overrides the frozen font binding");
        return matching.map(font => font.id);
      },
    });
  };
} catch (error) {
  globalThis.__DASHBOARD_LAYOUT_ERROR__ = error instanceof Error ? error.message : String(error);
}
