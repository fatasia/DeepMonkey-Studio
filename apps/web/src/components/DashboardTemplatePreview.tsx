import { useMemo, type CSSProperties } from "react";
import type { DashboardPageDocument } from "@bim-studio/contracts";
import type { AppLocale } from "../i18n";
import type { DashboardTemplateDefinition } from "./dashboardTemplateTypes";
import { buildDashboardTemplateNodes } from "./dashboardTemplateLayoutBuilder";
import "./DashboardTemplatePreview.css";

interface DashboardTemplatePreviewProps {
  locale: AppLocale;
  template: DashboardTemplateDefinition;
  page?: Pick<DashboardPageDocument, "width" | "height">;
}

/** 与实际插入使用同一布局工厂；不再用固定图形和虚构指标冒充模板数据。 */
export function DashboardTemplatePreview({ locale, template, page }: DashboardTemplatePreviewProps) {
  const width = page?.width ?? 1920, height = page?.height ?? 1080;
  const nodes = useMemo(() => buildDashboardTemplateNodes(locale,
    { id: "preview", name: "preview", width, height, viewportFit: "contain", nodes: [] }, template, 0), [locale, template, width, height]);
  const title = locale === "zh-CN" ? template.zh : template.en;
  return <div className="dashboard-template-card-preview template-layout-preview"
    style={{ "--template-accent": template.accent, "--template-surface": template.surface } as CSSProperties}
    aria-label={locale === "zh-CN" ? `${title}模板预览` : `${title} template preview`}>
    <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={title} preserveAspectRatio="xMidYMid meet">
      <title>{locale === "zh-CN" ? `${title} · 页面结构，数据待绑定` : `${title} · Layout, data not connected`}</title>
      {nodes.map(({ frame, widget }) => <g key={widget.key} data-template-node={widget.key} data-widget-type={widget.type}>
        <rect x={frame.x} y={frame.y} width={frame.width} height={frame.height} rx={8} />
        <svg x={frame.x + 12} y={frame.y + 8} width={Math.max(1, frame.width - 24)} height={Math.max(1, frame.height - 16)} overflow="hidden">
          <text x={0} y={20} fontSize={20}>{widget.title}</text>
          {widget.type === "filter" && <text x="90%" y={20} fontSize={20}>⌄</text>}
          {["value", "digital-flip", "progress", "status"].includes(widget.type) && <text x={0} y={49} fontSize={25}>— {widget.unit}</text>}
          {["table", "scroll-table", "rank"].includes(widget.type) && [0.3, 0.5, 0.7].map(ratio => <line key={ratio} x1={0} x2="100%" y1={`${ratio * 100}%`} y2={`${ratio * 100}%`} />)}
          {frame.height > 120 && !["table", "scroll-table", "rank", "decoration"].includes(widget.type) && <path d={`M 16 42 V ${frame.height - 32} H ${frame.width - 42}`} fill="none" />}
        </svg>
      </g>)}
    </svg>
  </div>;
}
