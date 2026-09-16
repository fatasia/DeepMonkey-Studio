import React from "react";
import { createRoot } from "react-dom/client";
import { DashboardReportTable } from "../../src/components/DashboardWidgetVisualization";
import { DashboardWidgetView } from "../../src/components/DashboardWidgetRuntime";
import { captureRenderedDashboardData } from "../../src/delivery/captureRenderedDashboardData";
import "../../src/styles/base.css";
import "../../src/styles/platform-components.css";
import "../../src/styles/dashboard-workspace.css";

// 请求由受宿主驱动的 addInitScript 注入;页面代码不自行决定任何身份。
interface TrustedLayoutRequest {
  widget: Record<string, unknown>;
  metric: { value?: number; samples: { time: number; value: number }[]; rows?: Record<string, unknown>[] };
  width: number;
  height: number;
  fonts: { id: string; base64?: string }[];
}
declare global {
  // eslint-disable-next-line no-var
  var __LAYOUT_REQUEST__: TrustedLayoutRequest | undefined;
  // eslint-disable-next-line no-var
  var __FONT_ERRORS__: string[] | undefined;
  // eslint-disable-next-line no-var
  var captureWidget: () => unknown;
}

const request = globalThis.__LAYOUT_REQUEST__;
globalThis.__FONT_ERRORS__ = [];
const none = () => {};
// Chromium 对 ArrayBuffer FontFace 懒解析:load() 不校验字节,必须用实际排版宽度验证注入生效。
function fontTakesEffect(family: string): boolean {
  const probe = document.createElement("span");
  probe.textContent = "MMMWMW";
  probe.style.cssText = "position:absolute;visibility:hidden;white-space:pre;font-size:32px;";
  const measure = (fontFamilies: string) => { probe.style.fontFamily = fontFamilies; document.body.append(probe); const width = probe.getBoundingClientRect().width; probe.remove(); return width; };
  const withFont = measure(`"${family}", monospace`);
  const fallbackOnly = measure("monospace");
  return Math.abs(withFont - fallbackOnly) > 0.01;
}
async function registerFrozenFonts(): Promise<void> {
  for (const font of request?.fonts ?? []) {
    if (!font.base64) continue;
    const bytes = Uint8Array.from(atob(font.base64), character => character.charCodeAt(0));
    const face = new FontFace(font.id, bytes.buffer as ArrayBuffer);
    try {
      await face.load;
      document.fonts.add(face);
      if (!fontTakesEffect(font.id)) globalThis.__FONT_ERRORS__!.push(font.id);
    } catch {
      globalThis.__FONT_ERRORS__!.push(font.id);
    }
  }
}
await registerFrozenFonts();
await document.fonts.ready;
const style = { width: request!.width, height: request!.height };
const widget = request!.widget as never;
const isTable = (request!.widget as { type?: string }).type === "table";
createRoot(document.getElementById("root")!).render(<section style={style}>
  {isTable
    ? <DashboardReportTable locale="zh-CN" compact={false} widget={widget} metric={request!.metric} onDataInteraction={none} />
    : <DashboardWidgetView locale="zh-CN" compact={false} widget={widget} metric={request!.metric}
      onDataInteraction={none} onAnimationStart={none} onAnimationEnd={none} />}
</section>);
globalThis.captureWidget = () => {
  const kind = isTable ? "table" : "value";
  const root = document.querySelectorAll<HTMLElement>(`[data-dashboard-capture="${kind}"]`)[0];
  if (!root) throw new Error(`No mounted ${kind} widget to capture`);
  const rect = root.getBoundingClientRect();
  try {
    const captured = captureRenderedDashboardData(root, { logicalSize: [rect.width, rect.height],
      resolveFonts: () => (request?.fonts ?? []).map(font => font.id) });
    return captured;
  } catch (error) {
    const detail = [...root.querySelectorAll("[data-capture-role]")].map(element => {
      const style = getComputedStyle(element);
      return { role: element.dataset.captureRole, lineHeight: style.lineHeight, fontSize: style.fontSize,
        text: (element.textContent ?? "").slice(0, 12) };
    });
    throw new Error(`${String(error)} | probe=${JSON.stringify(detail)}`);
  }
};
