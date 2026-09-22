import { useContext } from "react";
import type { DashboardDataWidgetConfig } from "@bim-studio/contracts";
import { DashboardMapPreviewGraphic } from "./DashboardMapPreviewGraphic";
import { PreviewMetadataContext, PreviewShell } from "./dashboardPreviewShared";
import { useDashboardPreviewGradientId as useGradientId } from "./dashboardComponentPreviewSvg";

type DecorationStyle = DashboardDataWidgetConfig["decorationStyle"];

export function LiquidPreview() {
  return (
    <PreviewShell variant="liquid">
      <i>
        <b className="wave wave-a" />
        <b className="wave wave-b" />
      </i>
      <em>68%</em>
    </PreviewShell>
  );
}

export function MapPreview() {
  const { preview } = useContext(PreviewMetadataContext);
  return (
    <PreviewShell variant="map">
      <DashboardMapPreviewGraphic mark={preview?.mark} />
    </PreviewShell>
  );
}

export function TablePreview({ scrolling }: { scrolling: boolean }) {
  return (
    <PreviewShell variant={`table ${scrolling ? "scrolling" : ""}`}>
      <i className="thead" />
      <i className="row" />
      <i className="row striped" />
      <i className="row" />
      {scrolling && <i className="scrollbar" />}
    </PreviewShell>
  );
}

export function MetricPreview({ type }: { type: "value" | "digital-flip" | "progress" | "status" }) {
  const sparkId = useGradientId("kp");
  if (type === "status") {
    return (
      <PreviewShell variant={`metric ${type}`}>
        <span className="status-dot" />
        <b className="status-label">运行中</b>
        <i className="status-sub" />
      </PreviewShell>
    );
  }
  if (type === "progress") {
    return (
      <PreviewShell variant={`metric ${type}`}>
        <b className="kpi">68<i className="unit">%</i></b>
        <span className="bar"><i style={{ width: "68%" }} /></span>
      </PreviewShell>
    );
  }
  if (type === "digital-flip") {
    return (
      <PreviewShell variant={`metric ${type}`}>
        <b className="kpi flip">1286</b>
        <span className="delta up">▲ 8.2%</span>
      </PreviewShell>
    );
  }
  return (
    <PreviewShell variant={`metric ${type}`}>
      <b className="kpi">86.4<i className="unit">万元</i></b>
      <span className="delta up">▲ 12.6%</span>
      <svg className="spark" viewBox="0 0 30 18" aria-hidden="true">
        <defs>
          <linearGradient id={sparkId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" className="stop-accent-strong" />
            <stop offset="1" className="stop-accent-ghost" />
          </linearGradient>
        </defs>
        <path className="spark-fill" d="M2 13L9 9 15 11 21 4 28 7 28 17 2 17Z" fill={`url(#${sparkId})`} />
        <path className="spark-line" d="M2 13L9 9 15 11 21 4 28 7" />
      </svg>
    </PreviewShell>
  );
}

export function FilterPreview() {
  return (
    <PreviewShell variant="filter">
      <svg className="funnel-icon" viewBox="0 0 12 12" aria-hidden="true">
        <path d="M1.5 2.5H10.5M3 6H9M4.6 9.5H7.4" />
      </svg>
      <i>全部设备</i>
      <b className="chevron" />
    </PreviewShell>
  );
}

export function RecordFormPreview() {
  return (
    <PreviewShell variant="record-form">
      <svg viewBox="0 0 96 64" aria-hidden="true">
        <g className="form-labels"><path d="M10 12H26M10 30H22" /></g>
        <rect className="form-field" x="10" y="15" width="66" height="9" rx="2.4" />
        <rect className="form-field field-focus" x="10" y="33" width="66" height="9" rx="2.4" />
        <rect className="form-submit" x="53" y="48" width="23" height="8" rx="2.4" />
        <path className="form-submit-label" d="M59 52H70" />
      </svg>
    </PreviewShell>
  );
}

export function TextPreview() {
  return (
    <PreviewShell variant="text">
      <i className="title-bar" />
      <b>工业看板标题</b>
      <span className="line" />
      <span className="line short" />
    </PreviewShell>
  );
}

export function ShapePreview() {
  return (
    <PreviewShell variant="shape">
      <i />
      <b />
      <span className="connector" />
    </PreviewShell>
  );
}

export function DecorationPreview({ style }: { style: NonNullable<DecorationStyle> }) {
  return (
    <PreviewShell variant={`decoration decoration-${style}`}>
      <i /><b />
      {(style === "title" || style === "header-wing" || style === "scan" || style === "neon") && <em>SECTION 01</em>}
    </PreviewShell>
  );
}
