import { useId, type CSSProperties } from "react";
import type { DashboardDataWidgetConfig } from "@bim-studio/contracts";
import { translate as tr, type AppLocale } from "../i18n";
import { buildDashboardReport, conditionalStyle, type DashboardAnalysisResult } from "./dashboardAnalytics";
import type { DashboardMetric } from "./DashboardWidgetRuntime";

export function DashboardDigitalFlip({
  widget,
  analysis,
  compact,
  onActivate,
}: {
  widget: DashboardDataWidgetConfig;
  analysis: DashboardAnalysisResult;
  compact: boolean;
  onActivate: () => void;
}) {
  const raw = analysis.value === undefined || analysis.value === null ? "—" : String(analysis.value);
  const characters = [...raw];
  const style = conditionalStyle(widget.conditionalRules, analysis.rows[0] ?? {}, analysis.value);
  return (
    <button
      type="button"
      aria-label={`${widget.title}: ${raw}${widget.unit}`}
      className={`dashboard-digital-flip ${style.animation === "pulse" ? "conditional-pulse" : ""}`}
      disabled={compact}
      onClick={onActivate}
      style={
        style.visible === false
          ? { display: "none" }
          : { color: style.color ?? widget.textColor, backgroundColor: style.backgroundColor, fontWeight: style.fontWeight ?? widget.fontWeight }
      }
    >
      <span>{widget.title}</span>
      <strong style={{ fontSize: widget.fontSize }}>
        {characters.map((character, index) => (
          <i className={/\d/.test(character) ? "digit" : "separator"} key={`${index}-${character}`}>
            {character}
          </i>
        ))}
        <small>{widget.unit}</small>
      </strong>
    </button>
  );
}

export function DashboardLiquidFill({
  locale,
  widget,
  analysis,
  compact,
  onActivate,
}: {
  locale: AppLocale;
  widget: DashboardDataWidgetConfig;
  analysis: DashboardAnalysisResult;
  compact: boolean;
  onActivate: () => void;
}) {
  const clipId = `dashboard-liquid-${useId().replaceAll(":", "")}`;
  const min = widget.min ?? 0;
  const max = widget.max ?? 100;
  const numeric = finiteNumber(analysis.value) ?? min;
  const ratio = Math.max(0, Math.min(1, (numeric - min) / Math.max(1, max - min)));
  const surfaceY = 108 - ratio * 96;
  const style = conditionalStyle(widget.conditionalRules, analysis.rows[0] ?? {}, analysis.value);
  return (
    <button
      type="button"
      className={`dashboard-liquid-fill ${style.animation === "pulse" ? "conditional-pulse" : ""}`}
      disabled={compact}
      onClick={onActivate}
      style={style.visible === false ? { display: "none" } : { color: style.color ?? widget.textColor, backgroundColor: style.backgroundColor }}
    >
      <svg viewBox="0 0 120 120" role="img" aria-label={`${widget.title}: ${numeric}${widget.unit}`}>
        <defs>
          <clipPath id={clipId}>
            <circle cx="60" cy="60" r="48" />
          </clipPath>
        </defs>
        <circle className="liquid-shell" cx="60" cy="60" r="49" />
        <g clipPath={`url(#${clipId})`} style={{ color: style.color ?? widget.color }}>
          <rect className="liquid-body" x="0" y={surfaceY} width="120" height={120 - surfaceY} />
          <path
            className={compact ? "liquid-wave" : "liquid-wave running"}
            d="M-48 0 Q-36 -7 -24 0 T0 0 T24 0 T48 0 T72 0 T96 0 T120 0 T144 0 T168 0 V16 H-48 Z"
            transform={`translate(0 ${surfaceY})`}
          />
        </g>
      </svg>
      <span>
        <small>{widget.title}</small>
        <strong>
          {numeric}
          <em>{widget.unit}</em>
        </strong>
        <i>
          {Math.round(ratio * 100)}% · {tr(locale, "量程", "Range")} {min}–{max}
        </i>
      </span>
    </button>
  );
}

export function DashboardScrollTable({
  locale,
  widget,
  metric,
  compact,
  onRowInteraction,
}: {
  locale: AppLocale;
  widget: DashboardDataWidgetConfig;
  metric: DashboardMetric | undefined;
  compact: boolean;
  onRowInteraction: (row: Record<string, unknown>, index: number) => void;
}) {
  const report = buildDashboardReport(widget, metric);
  const columns = report.columns.slice(0, 5);
  const pageSize = Math.max(1, widget.report?.pageSize ?? 6);
  const running = !compact && report.rows.length > pageSize;
  const sourceRows = compact ? report.rows.slice(0, pageSize) : report.rows;
  const rows = running ? [...sourceRows, ...sourceRows] : sourceRows;
  const duration = Math.max(8, sourceRows.length * 1.8);
  return (
    <div className="dashboard-scroll-table" role="table" aria-label={widget.title}>
      <header>
        <strong>{widget.title}</strong>
        <small>
          {report.rows.length} {tr(locale, "行", "rows")}
        </small>
      </header>
      {columns.length > 0 ? (
        <>
          <div className="dashboard-scroll-table-head" role="row" style={{ gridTemplateColumns: `repeat(${columns.length},minmax(0,1fr))` }}>
            {columns.map((column) => (
              <b role="columnheader" key={column}>
                {column}
              </b>
            ))}
          </div>
          <div className="dashboard-scroll-table-window">
            <div className={`dashboard-scroll-table-track ${running ? "running" : ""}`} style={{ "--dashboard-scroll-duration": `${duration}s` } as CSSProperties}>
              {rows.map((row, index) => {
                const sourceIndex = index % Math.max(1, sourceRows.length);
                const rowStyle = conditionalStyle(widget.conditionalRules, row);
                return (
                  <button
                    type="button"
                    role="row"
                    disabled={compact}
                    className={rowStyle.animation === "pulse" ? "conditional-pulse" : ""}
                    style={
                      rowStyle.visible === false
                        ? { display: "none" }
                        : {
                            gridTemplateColumns: `repeat(${columns.length},minmax(0,1fr))`,
                            color: rowStyle.color,
                            backgroundColor: rowStyle.backgroundColor,
                            fontWeight: rowStyle.fontWeight,
                          }
                    }
                    key={`${index}-${sourceIndex}`}
                    onClick={() => onRowInteraction(row, sourceIndex)}
                  >
                    {columns.map((column) => (
                      <span role="cell" key={column}>
                        {String(row[column] ?? "—")}
                      </span>
                    ))}
                  </button>
                );
              })}
            </div>
          </div>
        </>
      ) : (
        <div className="dashboard-scroll-table-empty">{tr(locale, "暂无表格数据", "No table data")}</div>
      )}
    </div>
  );
}

function finiteNumber(value: unknown): number | undefined {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : undefined;
}
