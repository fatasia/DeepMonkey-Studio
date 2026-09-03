import { useMemo, useState } from "react";
import { ArrowRight, Box, Gauge, LoaderCircle, Play, XCircle } from "lucide-react";
import type { DataPipelineNode, DataPipelinePreview } from "@bim-studio/contracts";
import type { AppLocale } from "../i18n";
import { translate as tr } from "../i18n";

type SampleSide = "input" | "output";

export function DataPipelineDebugPanel({
  locale,
  preview,
  selectedNode,
  busy,
  onRunThrough,
}: {
  locale: AppLocale;
  preview?: DataPipelinePreview | undefined;
  selectedNode?: DataPipelineNode | undefined;
  busy: boolean;
  onRunThrough: () => void;
}) {
  const [side, setSide] = useState<SampleSide>("output");
  const diagnostic = preview?.diagnostics.find((item) => item.nodeId === selectedNode?.id);
  const rows = diagnostic
    ? side === "input"
      ? diagnostic.inputSample ?? []
      : diagnostic.sample ?? []
    : selectedNode
      ? []
      : preview?.rows ?? [];
  const fields = useMemo(() => [...new Set(rows.flatMap((row) => Object.keys(row)))], [rows]);
  const isPartial = Boolean(preview?.executedThroughNodeId);
  const canRunThrough = Boolean(selectedNode && selectedNode.type !== "output");
  const rowCount = diagnostic
    ? side === "input"
      ? diagnostic.inputRows
      : diagnostic.outputRows
    : preview?.rows.length ?? 0;

  return (
    <section className="pipeline-result pipeline-debug-panel">
      <header>
        <span>
          <strong>{tr(locale, "节点调试", "Node debugging")}</strong>
          <small>
            {diagnostic
              ? `${diagnostic.inputRows} → ${diagnostic.outputRows} ${tr(locale, "行", "rows")} · ${diagnostic.durationMs.toFixed(1)}ms`
              : tr(locale, "选择节点查看输入与输出", "Select a node to inspect its input and output")}
          </small>
        </span>
        <div className="pipeline-debug-actions">
          {preview && (
            <span className={preview.status === "success" ? "success" : "error"}>
              <Gauge size={13} />
              {preview.diagnostics.filter((item) => item.status === "success").length}/{preview.diagnostics.length}
              {isPartial ? tr(locale, " · 运行至此", " · through node") : ""}
            </span>
          )}
          {canRunThrough && (
            <button disabled={busy} onClick={onRunThrough}>
              {busy ? <LoaderCircle className="spin" size={13} /> : <Play size={13} />}
              {tr(locale, "运行到此", "Run to node")}
            </button>
          )}
        </div>
      </header>
      {diagnostic && (
        <div className="pipeline-debug-tabs" role="tablist" aria-label={tr(locale, "节点数据方向", "Node data side")}>
          <button role="tab" aria-selected={side === "input"} className={side === "input" ? "active" : ""} onClick={() => setSide("input")}>
            {tr(locale, "输入", "Input")} <b>{diagnostic.inputRows}</b>
          </button>
          <ArrowRight size={13} />
          <button role="tab" aria-selected={side === "output"} className={side === "output" ? "active" : ""} onClick={() => setSide("output")}>
            {tr(locale, "输出", "Output")} <b>{diagnostic.outputRows}</b>
          </button>
        </div>
      )}
      {(diagnostic?.error && side === "output") || (!diagnostic && preview?.error) ? (
        <div className="pipeline-result-error">
          <XCircle size={18} />
          <span>
            <strong>{diagnostic ? tr(locale, "当前节点失败", "Node failed") : tr(locale, "运行失败", "Run failed")}</strong>
            {diagnostic?.error ?? preview?.error}
          </span>
        </div>
      ) : rows.length ? (
        <div className="pipeline-result-table">
          <table>
            <thead><tr>{fields.map((field) => <th key={field}>{field}</th>)}</tr></thead>
            <tbody>
              {rows.map((row, index) => (
                <tr key={index}>{fields.map((field) => <td key={field}>{formatValue(row[field])}</td>)}</tr>
              ))}
            </tbody>
          </table>
          <small className="pipeline-debug-sample-note">
            {tr(locale, `显示 ${rows.length} 行样例，共 ${rowCount} 行`, `Showing ${rows.length} sample rows of ${rowCount}`)}
          </small>
        </div>
      ) : (
        <div className="pipeline-panel-empty">
          <Box size={24} />
          {preview
            ? diagnostic
              ? tr(locale, side === "input" ? "当前节点没有输入数据" : "当前节点没有输出数据", side === "input" ? "This node has no input" : "This node has no output")
              : tr(locale, "当前节点本次未执行，可运行到此继续调试", "This node did not run; run to it to continue debugging")
            : tr(locale, "运行全流程，或选择节点后运行到此", "Run the full pipeline, or select a node and run to it")}
        </div>
      )}
    </section>
  );
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "number" && Number.isFinite(value))
    return new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 6, useGrouping: false }).format(value);
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}
