import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { GitCompareArrows, Highlighter, LoaderCircle, LocateFixed, X } from "lucide-react";
import { translate as tr, type AppLocale } from "../i18n";
import type { ComponentRecord } from "../viewer/analysis";
import type { ModelDiffReport } from "../viewer/modelDiff";
import type { LoadedSceneModel, ViewerEngine } from "../viewer/ViewerEngine";
import { diffHighlightEntries, modelDiffSnapshotStore, runModelDiff } from "./modelDiffReviewModel";
import "./modelDiffReviewPanel.css";

const RESULT_RENDER_LIMIT = 100;

interface ModelDiffReviewPanelProps {
  locale: AppLocale;
  engine: ViewerEngine | undefined;
  models: LoadedSceneModel[];
  onLocate: (record: ComponentRecord) => void;
  onClose: () => void;
}

interface DiffListProps {
  locale: AppLocale;
  title: string;
  kind: "added" | "removed" | "modified";
  records: Array<{ key: string; name: string; subtitle: string; detail?: string; record: ComponentRecord }>;
  emptyText: string;
  onLocate: (record: ComponentRecord) => void;
}

export function ModelDiffReviewPanel({ locale, engine, models, onLocate, onClose }: ModelDiffReviewPanelProps) {
  const snapshots = useSyncExternalStore(modelDiffSnapshotStore.subscribe, modelDiffSnapshotStore.getSnapshot, modelDiffSnapshotStore.getSnapshot);
  const [beforeId, setBeforeId] = useState<string>();
  const [afterId, setAfterId] = useState<string>();
  const [report, setReport] = useState<ModelDiffReport>();
  const [highlightOn, setHighlightOn] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const highlightOnRef = useRef(false);
  highlightOnRef.current = highlightOn;
  const instanceModels = models.filter((model) => model.kind === "model");
  useEffect(() => () => {
    // 关闭评审即结束评审会话；高亮是只读 overlay，不遗留到普通浏览。
    if (highlightOnRef.current) engine?.clearModelDiffHighlight();
  }, [engine]);

  function capture(modelId: string) {
    if (!engine) return;
    const snapshot = engine.captureModelDiffSnapshot(modelId);
    if (!snapshot) {
      setError(tr(locale, "该实例尚未建立构件索引，请等待加载完成", "This instance has no component index yet; wait for loading"));
      return;
    }
    setError("");
    const entry = modelDiffSnapshotStore.add(snapshot);
    setAfterId((current) => current ?? entry.id);
    setBeforeId((current) => current ?? undefined);
  }

  async function toggleHighlight() {
    if (!engine || !report) return;
    if (highlightOn) {
      engine.clearModelDiffHighlight();
      setHighlightOn(false);
      return;
    }
    setWorking(true);
    setError("");
    try {
      await engine.setModelDiffHighlight(diffHighlightEntries(report));
      setHighlightOn(true);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setWorking(false);
    }
  }

  function run() {
    const before = beforeId ? modelDiffSnapshotStore.get(beforeId) : undefined;
    const after = afterId ? modelDiffSnapshotStore.get(afterId) : undefined;
    if (!before || !after || before.id === after.id) return;
    if (highlightOn) { engine?.clearModelDiffHighlight(); setHighlightOn(false); }
    setError("");
    setReport(runModelDiff(before, after));
  }

  const before = beforeId ? modelDiffSnapshotStore.get(beforeId) : undefined;
  const after = afterId ? modelDiffSnapshotStore.get(afterId) : undefined;

  return (
    <div className="dialog-backdrop" data-escape-dialog="" onMouseDown={onClose}>
      <section
        className="dialog model-diff-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={tr(locale, "模型版本对比评审", "Model version diff review")}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <span className="eyebrow">P1 · DESIGN DIFF REVIEW</span>
        <h2>{tr(locale, "模型版本对比评审", "Model version diff review")}</h2>
        <button type="button" className="model-diff-close" aria-label={tr(locale, "关闭对比评审", "Close diff review")} onClick={onClose}><X size={15} /></button>

        <section className="model-diff-section" aria-label={tr(locale, "捕获快照", "Capture snapshots")}>
          <h3>{tr(locale, "1 · 从已加载实例捕获快照", "1 · Capture snapshots from loaded instances")}</h3>
          {instanceModels.length === 0
            ? <p className="model-diff-empty">{tr(locale, "场景中还没有模型实例；请先从资源面板载入两个版本。", "No model instances in this scene; load two versions first.")}</p>
            : <ul className="model-diff-models">
              {instanceModels.map((model) => (
                <li key={model.id}>
                  <span title={model.name}>{model.name}</span>
                  <button type="button" disabled={!engine || working} onClick={() => capture(model.id)}>
                    {tr(locale, "捕获快照", "Capture")}
                  </button>
                </li>
              ))}
            </ul>}
          {snapshots.length > 0 && (
            <div className="model-diff-pick">
              <label className="field">
                <span>{tr(locale, "对比基线（before）", "Baseline (before)")}</span>
                <select value={beforeId ?? ""} onChange={(event) => setBeforeId(event.target.value || undefined)}>
                  <option value="">{tr(locale, "未选择", "Not selected")}</option>
                  {snapshots.map((entry) => <option key={entry.id} value={entry.id}>{entry.label}</option>)}
                </select>
              </label>
              <label className="field">
                <span>{tr(locale, "对比目标（after）", "Target (after)")}</span>
                <select value={afterId ?? ""} onChange={(event) => setAfterId(event.target.value || undefined)}>
                  <option value="">{tr(locale, "未选择", "Not selected")}</option>
                  {snapshots.map((entry) => <option key={entry.id} value={entry.id}>{entry.label}</option>)}
                </select>
              </label>
              <button type="button" className="button primary model-diff-run" disabled={!before || !after || before.id === after.id} onClick={run}>
                <GitCompareArrows size={15} />{tr(locale, "运行对比", "Run diff")}
              </button>
            </div>
          )}
          {snapshots.length === 0 && (
            <p className="model-diff-empty">
              {tr(locale, "先捕获两个快照（例如替换素材前后各一次，或载入新旧两个版本后分别捕获）。", "Capture two snapshots first (before and after a replacement, or from two loaded versions).")}
            </p>
          )}
        </section>

        {report && (
          <ModelDiffReportView
            locale={locale}
            report={report}
            highlightOn={highlightOn}
            working={working}
            onToggleHighlight={() => void toggleHighlight()}
            onLocate={onLocate}
          />
        )}

        {error && <p className="model-diff-error" role="alert">{error}</p>}

        {error && <p className="model-diff-error" role="alert">{error}</p>}
        <footer className="model-diff-footnote">
          {tr(locale, "身份=源内稳定 ID（IFC GlobalId / ElementId / 结构路径）；几何级差异由编译链几何质量报告承担；快照仅存于当前会话。", "Identity = in-source stable ID (IFC GlobalId / ElementId / structural path); geometry-level deltas are covered by the compile-chain quality report; snapshots live in this session only.")}
        </footer>
        <div className="dialog-actions">
          <button type="button" className="button" onClick={onClose}>{tr(locale, "关闭", "Close")}</button>
        </div>
      </section>
    </div>
  );
}

/** diff 结果展示；独立导出以便在无交互的静态渲染测试中验证真实报告。 */
export function ModelDiffReportView({ locale, report, highlightOn, working, onToggleHighlight, onLocate }: {
  locale: AppLocale;
  report: ModelDiffReport;
  highlightOn: boolean;
  working: boolean;
  onToggleHighlight: () => void;
  onLocate: (record: ComponentRecord) => void;
}) {
  const summary = report.summary;
  return (
    <section className="model-diff-section" aria-label={tr(locale, "对比结果", "Diff result")}>
      <h3>
        {tr(locale, "2 · 变更清单", "2 · Changes")}
        <button
          type="button"
          className={`model-diff-highlight-toggle${highlightOn ? " on" : ""}`}
          disabled={working || (!report.hasChanges && !highlightOn)}
          title={tr(locale, "新增绿 / 删除红 / 修改黄（只读覆盖，可随时清除）", "Added green / removed red / modified yellow (read-only overlay, clear anytime)")}
          onClick={onToggleHighlight}
        >
          {working ? <LoaderCircle className="spin" size={13} /> : <Highlighter size={13} />}
          {highlightOn ? tr(locale, "清除高亮", "Clear highlight") : tr(locale, "三色高亮", "3-color highlight")}
        </button>
      </h3>
      <div className="model-diff-summary">
        <span className="diff-chip added">{tr(locale, `新增 ${summary.addedCount}`, `${summary.addedCount} added`)}</span>
        <span className="diff-chip removed">{tr(locale, `删除 ${summary.removedCount}`, `${summary.removedCount} removed`)}</span>
        <span className="diff-chip modified">{tr(locale, `修改 ${summary.modifiedCount}`, `${summary.modifiedCount} modified`)}</span>
        <span className="diff-chip unchanged">{tr(locale, `未变化 ${report.unchangedCount}`, `${report.unchangedCount} unchanged`)}</span>
        <span className="diff-chip kinds" title={tr(locale, "身份/语义/属性字段变更计数", "Identity / semantic / property field change counts")}>
          {tr(locale, `身份 ${summary.identityChanges} · 语义 ${summary.semanticChanges} · 属性 ${summary.propertyChanges}`, `identity ${summary.identityChanges} · semantic ${summary.semanticChanges} · property ${summary.propertyChanges}`)}
        </span>
      </div>
      {!report.hasChanges && <p className="model-diff-empty">{tr(locale, "两个快照记录完全一致，没有变更。", "Both snapshots are identical; no changes.")}</p>}
      <DiffList
        locale={locale} kind="added" title={tr(locale, "新增构件", "Added components")}
        records={report.added.map((record) => ({ key: record.stableId, name: record.name, subtitle: [record.level, record.category].filter(Boolean).join(" · "), record }))}
        emptyText={tr(locale, "没有新增构件", "No added components")} onLocate={onLocate}
      />
      <DiffList
        locale={locale} kind="removed" title={tr(locale, "删除构件", "Removed components")}
        records={report.removed.map((record) => ({ key: record.stableId, name: record.name, subtitle: [record.level, record.category].filter(Boolean).join(" · "), record }))}
        emptyText={tr(locale, "没有删除构件", "No removed components")} onLocate={onLocate}
      />
      <DiffList
        locale={locale} kind="modified" title={tr(locale, "修改构件", "Modified components")}
        records={report.modified.map((change) => {
          const first = change.changedFields[0];
          return {
            key: change.stableId,
            name: change.after.name,
            subtitle: first ? `${first.field}: ${first.before || "—"} → ${first.after || "—"}` : "",
            detail: change.changedFields.map((field) => `${field.field}: ${field.before || "—"} → ${field.after || "—"}`).join("\n"),
            record: change.after,
          };
        })}
        emptyText={tr(locale, "没有修改构件", "No modified components")} onLocate={onLocate}
      />
    </section>
  );
}

function DiffList({ locale, title, kind, records, emptyText, onLocate }: DiffListProps) {
  return (
    <div className="model-diff-list-group">
      <h4><i className={`diff-dot ${kind}`} aria-hidden="true" />{title}<small>{records.length}</small></h4>
      {records.length === 0 ? (
        <p className="model-diff-list-empty">{emptyText}</p>
      ) : (
        <ul className="model-diff-list">
          {records.slice(0, RESULT_RENDER_LIMIT).map((item) => (
            <li key={item.key}>
              <div>
                <strong title={item.name}>{item.name}</strong>
                <small title={item.detail}>{item.subtitle}</small>
              </div>
              <button type="button" title={tr(locale, "定位构件", "Focus component")} onClick={() => onLocate(item.record)}>
                <LocateFixed size={13} />{tr(locale, "定位", "Focus")}
              </button>
            </li>
          ))}
          {records.length > RESULT_RENDER_LIMIT && <li className="model-diff-overflow">{tr(locale, `其余 ${records.length - RESULT_RENDER_LIMIT} 项未展开`, `${records.length - RESULT_RENDER_LIMIT} more not listed`)}</li>}
        </ul>
      )}
    </div>
  );
}
