import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, Boxes, Crosshair, Download, FileSpreadsheet, LoaderCircle, Play, Plus, ShieldCheck, Trash2, X } from "lucide-react";
import type { SceneEngineeringAnalysisState, SceneQtoCategoryMapping } from "@bim-studio/contracts";
import type { AppLocale } from "../i18n";
import { translate as tr } from "../i18n";
import { downloadTextFile } from "../browserDownload";
import type { LoadedSceneModel } from "../viewer/viewerTypes";
import { applyQtoCategoryMapping } from "../viewer/engineeringAnalysisState";
import { buildQtoReport, qtoReportToCsv, type QtoReport } from "../viewer/qtoTakeoff";
import {
  reportToCsv,
  reportToJson,
  runSpatialValidation,
  type SpatialRule,
  type SpatialValidationReport,
} from "../viewer/spatialValidation";
import "./SceneEngineeringAnalysisPanel.css";

interface SceneEngineeringAnalysisPanelProps {
  locale: AppLocale;
  sceneName: string;
  models: LoadedSceneModel[];
  /** 场景文档保存的 P5 规则与 P7 口径（受控：编辑即走场景保存链路）。 */
  value: SceneEngineeringAnalysisState;
  onChange: (next: SceneEngineeringAnalysisState) => void;
  /** 结果定位回跳；缺省或返回 false 表示无法定位。 */
  onFocusObject?: (id: string) => boolean;
  onClose: () => void;
}

interface EngineeringAnalysisResult {
  spatial: SpatialValidationReport;
  qto: QtoReport;
  /** QTO 行（category∥level）→ 参与该行的对象 id，供行项点击定位。 */
  qtoLineObjects: Record<string, string[]>;
}

const MAPPING_SOURCE_LABELS: Record<SceneQtoCategoryMapping["source"], { zh: string; en: string }> = {
  "material-name": { zh: "材质名", en: "Material name" },
  "object-name": { zh: "对象名", en: "Object name" },
  "custom-property": { zh: "自定义属性", en: "Custom property" },
};

/** P5/P7 工程分析：规则与 QTO 口径来自场景文档状态，结果支持定位回跳。 */
export function SceneEngineeringAnalysisPanel(props: SceneEngineeringAnalysisPanelProps) {
  const analysis = props.value;
  const [phase, setPhase] = useState<"idle" | "running" | "ready" | "error">("idle");
  const [result, setResult] = useState<EngineeringAnalysisResult>();
  const [message, setMessage] = useState("");
  const visibleModels = useMemo(() => props.models.filter((model) => model.visible && model.object.visible), [props.models]);

  useEffect(() => {
    const close = (event: KeyboardEvent) => { if (event.key === "Escape") props.onClose(); };
    document.addEventListener("keydown", close);
    return () => document.removeEventListener("keydown", close);
  }, [props.onClose]);

  function update(patch: Partial<SceneEngineeringAnalysisState>) {
    props.onChange({ ...analysis, ...patch });
  }

  function updateMapping(id: string, patch: Partial<SceneQtoCategoryMapping>) {
    update({ qtoMappings: (analysis.qtoMappings ?? []).map((mapping) => (mapping.id === id ? { ...mapping, ...patch } : mapping)) });
  }

  function addMapping() {
    const mapping: SceneQtoCategoryMapping = { id: crypto.randomUUID(), enabled: true, source: "object-name", pattern: "", category: "" };
    update({ qtoMappings: [...(analysis.qtoMappings ?? []), mapping] });
  }

  function removeMapping(id: string) {
    update({ qtoMappings: (analysis.qtoMappings ?? []).filter((mapping) => mapping.id !== id) });
  }

  function runAnalysis() {
    if (!visibleModels.length) return;
    setPhase("running");
    setMessage("");
    const snapshot = { minimumClearance: analysis.minimumClearance, heightLimit: analysis.heightLimit, qtoMappings: analysis.qtoMappings ?? [] };
    window.setTimeout(() => {
      try {
        setResult(buildEngineeringAnalysis(visibleModels, snapshot.minimumClearance, snapshot.heightLimit, snapshot.qtoMappings));
        setPhase("ready");
      } catch (error) {
        setPhase("error");
        setMessage(error instanceof Error ? error.message : tr(props.locale, "未知分析错误", "Unknown analysis error"));
      }
    }, 0);
  }

  function focusObject(id: string | undefined) {
    if (!id) return;
    const focused = props.onFocusObject?.(id) ?? false;
    setMessage(focused
      ? tr(props.locale, `已定位到 ${id}`, `Focused ${id}`)
      : tr(props.locale, `无法定位 ${id}（对象可能已被隐藏或删除）`, `Cannot focus ${id} (object may be hidden or removed)`));
  }

  function download(format: "spatial-json" | "spatial-csv" | "qto-csv") {
    if (!result) return;
    try {
      const stem = safeFileStem(props.sceneName);
      if (format === "spatial-json") downloadTextFile(reportToJson(result.spatial), `${stem}-spatial-validation.json`, "application/json;charset=utf-8");
      if (format === "spatial-csv") downloadTextFile(`\uFEFF${reportToCsv(result.spatial)}`, `${stem}-spatial-validation.csv`, "text/csv;charset=utf-8");
      if (format === "qto-csv") downloadTextFile(`\uFEFF${qtoReportToCsv(result.qto)}`, `${stem}-qto.csv`, "text/csv;charset=utf-8");
      setMessage(tr(props.locale, "报告已下载", "Report downloaded"));
    } catch (error) {
      setMessage(tr(props.locale, `导出失败：${error instanceof Error ? error.message : "未知错误"}`, `Export failed: ${error instanceof Error ? error.message : "unknown error"}`));
    }
  }

  return <section className="scene-engineering-analysis" aria-label={tr(props.locale, "工程分析", "Engineering analysis")}>
    <header>
      <span><ShieldCheck size={17} /><span><strong>{tr(props.locale, "工程分析", "Engineering analysis")}</strong><small>P5 · P7</small></span></span>
      <button type="button" aria-label={tr(props.locale, "关闭工程分析", "Close engineering analysis")} onClick={props.onClose}><X size={16} /></button>
    </header>

    {!visibleModels.length ? <div className="scene-engineering-empty">
      <Boxes size={28} />
      <strong>{tr(props.locale, "当前没有可分析的可见对象", "No visible objects to analyze")}</strong>
      <span>{tr(props.locale, "载入模型或显示已隐藏对象后重试。", "Load a model or show hidden objects, then retry.")}</span>
    </div> : <>
      <div className="scene-engineering-config">
        <label><span>{tr(props.locale, "最小净空", "Minimum clearance")}</span><span><input type="number" min="0" step="0.05" value={analysis.minimumClearance} onChange={(event) => update({ minimumClearance: validNonNegative(event.currentTarget.value, analysis.minimumClearance) })} /> m</span></label>
        <label><span>{tr(props.locale, "限高", "Height limit")}</span><span><input type="number" min="0.01" step="0.1" value={analysis.heightLimit} onChange={(event) => update({ heightLimit: validPositive(event.currentTarget.value, analysis.heightLimit) })} /> m</span></label>
        <button type="button" className="primary" disabled={phase === "running"} onClick={runAnalysis}>
          {phase === "running" ? <LoaderCircle className="spin" size={14} /> : <Play size={14} />}
          {phase === "running" ? tr(props.locale, "正在分析", "Analyzing") : tr(props.locale, "运行分析", "Run analysis")}
        </button>
      </div>

      <div className="scene-engineering-mappings">
        <div className="scene-engineering-mappings-head">
          <strong>{tr(props.locale, "QTO 分类口径", "QTO category mapping")}</strong>
          <button type="button" onClick={addMapping}><Plus size={13} />{tr(props.locale, "添加映射", "Add mapping")}</button>
        </div>
        <p>{tr(props.locale, "按顺序应用，首条命中生效；未命中沿用内置类别推断。规则随场景保存。", "Applied in order; first hit wins. Unmatched objects fall back to built-in inference. Rules persist with the scene.")}</p>
        {(analysis.qtoMappings ?? []).map((mapping) => <div key={mapping.id} className="scene-engineering-mapping" data-enabled={mapping.enabled}>
          <label><input type="checkbox" checked={mapping.enabled} onChange={(event) => updateMapping(mapping.id, { enabled: event.currentTarget.checked })} aria-label={tr(props.locale, "启用映射", "Enable mapping")} /></label>
          <select value={mapping.source} onChange={(event) => updateMapping(mapping.id, { source: event.currentTarget.value as SceneQtoCategoryMapping["source"] })} aria-label={tr(props.locale, "匹配来源", "Match source")}>
            {(Object.keys(MAPPING_SOURCE_LABELS) as Array<SceneQtoCategoryMapping["source"]>).map((source) => (
              <option key={source} value={source}>{tr(props.locale, MAPPING_SOURCE_LABELS[source].zh, MAPPING_SOURCE_LABELS[source].en)}</option>
            ))}
          </select>
          {mapping.source === "custom-property"
            ? <input type="text" placeholder={tr(props.locale, "属性键", "Property key")} value={mapping.propertyKey ?? ""} onChange={(event) => updateMapping(mapping.id, { propertyKey: event.currentTarget.value })} aria-label={tr(props.locale, "属性键", "Property key")} />
            : null}
          <input type="text" placeholder={mapping.source === "custom-property" ? tr(props.locale, "值包含(可选)", "Value contains (optional)") : tr(props.locale, "包含文本", "Contains text")} value={mapping.pattern} onChange={(event) => updateMapping(mapping.id, { pattern: event.currentTarget.value })} aria-label={tr(props.locale, "匹配文本", "Match text")} className={mapping.source === "custom-property" ? undefined : "scene-engineering-mapping-span2"} />
          <input type="text" placeholder={tr(props.locale, "QTO 类别", "QTO category")} value={mapping.category} onChange={(event) => updateMapping(mapping.id, { category: event.currentTarget.value })} aria-label={tr(props.locale, "QTO 类别", "QTO category")} />
          <button type="button" aria-label={tr(props.locale, "删除映射", "Remove mapping")} onClick={() => removeMapping(mapping.id)}><Trash2 size={13} /></button>
        </div>)}
      </div>

      {phase === "idle" && <p className="scene-engineering-guidance">{tr(props.locale, `将检查 ${visibleModels.length} 个可见对象；碰撞和净空比较模型与基础元素，QTO 按口径映射与楼层聚合。`, `${visibleModels.length} visible objects will be checked. Collision and clearance compare models with primitives; QTO groups by mapped category and level.`)}</p>}
      {phase === "error" && <p className="scene-engineering-error" role="alert"><AlertTriangle size={14} />{message}</p>}
      {result && phase === "ready" && <AnalysisResult locale={props.locale} result={result} onDownload={download} onFocusObject={focusObject} />}
    </>}
    <footer><span role="status" aria-live="polite">{message}</span><small>{tr(props.locale, "结果为几何工程辅助证据，不替代规范审查。", "Results are geometric engineering evidence, not a code review.")}</small></footer>
  </section>;
}

function AnalysisResult({ locale, result, onDownload, onFocusObject }: {
  locale: AppLocale;
  result: EngineeringAnalysisResult;
  onDownload: (format: "spatial-json" | "spatial-csv" | "qto-csv") => void;
  onFocusObject: (id: string | undefined) => void;
}) {
  const violations = result.spatial.findings.filter((finding) => finding.status === "fail").length;
  return <div className="scene-engineering-results">
    <div className="scene-engineering-metrics">
      <span><small>{tr(locale, "对象", "Objects")}</small><strong>{result.qto.objectCount}</strong></span>
      <span><small>{tr(locale, "违规", "Violations")}</small><strong>{violations}</strong></span>
      <span><small>{tr(locale, "工程量行", "QTO lines")}</small><strong>{result.qto.lines.length}</strong></span>
      <span><small>{tr(locale, "疑似开放网格", "Open mesh suspects")}</small><strong>{result.qto.lines.reduce((sum, line) => sum + line.openMeshSuspectedCount, 0)}</strong></span>
    </div>
    <div className="scene-engineering-actions">
      <button type="button" onClick={() => onDownload("spatial-json")}><Download size={13} />{tr(locale, "空间报告 JSON", "Spatial JSON")}</button>
      <button type="button" onClick={() => onDownload("spatial-csv")}><FileSpreadsheet size={13} />{tr(locale, "空间明细 CSV", "Spatial CSV")}</button>
      <button type="button" onClick={() => onDownload("qto-csv")}><FileSpreadsheet size={13} />{tr(locale, "工程量 CSV", "QTO CSV")}</button>
    </div>
    {result.spatial.findings.length > 0 && <ul>
      {result.spatial.findings.slice(0, 4).map((finding) => {
        const focusable = finding.objectIdA ?? finding.objectIdB;
        return <li key={finding.ruleId} data-status={finding.status}>
          <button type="button" className="scene-engineering-locate" disabled={!focusable} title={focusable ? tr(locale, "定位到对象", "Focus object") : undefined} onClick={() => onFocusObject(focusable)}><Crosshair size={12} />{finding.ruleLabel}</button>
          <strong>{finding.status === "fail" ? tr(locale, "未通过", "Failed") : finding.status === "pass" ? tr(locale, "通过", "Passed") : tr(locale, "已跳过", "Skipped")}</strong>
          <small>{finding.detail}</small>
        </li>;
      })}
    </ul>}
    {result.qto.lines.length > 0 && <ul>
      {result.qto.lines.slice(0, 8).map((line) => {
        const key = `${line.category}∥${line.level}`;
        const focusable = result.qtoLineObjects[key]?.[0];
        return <li key={key} data-status="pass">
          <button type="button" className="scene-engineering-locate" disabled={!focusable} title={focusable ? tr(locale, "定位到该行首个对象", "Focus first object of this line") : undefined} onClick={() => onFocusObject(focusable)}><Crosshair size={12} />{line.category} × {line.level}</button>
          <strong>{line.count}</strong>
          <small>{tr(locale, "体积", "Volume")} {line.totalVolumeCubicMetres} m³ · {tr(locale, "面积", "Area")} {line.totalSurfaceAreaSquareMetres} m²</small>
        </li>;
      })}
    </ul>}
  </div>;
}

export function buildEngineeringAnalysis(
  models: LoadedSceneModel[],
  minimumClearance: number,
  heightLimit: number,
  qtoMappings: readonly SceneQtoCategoryMapping[] = [],
): EngineeringAnalysisResult {
  if (!Number.isFinite(minimumClearance) || minimumClearance < 0) throw new Error("最小净空必须为非负数");
  if (!Number.isFinite(heightLimit) || heightLimit <= 0) throw new Error("限高必须大于 0");
  const objects = models.map((model) => ({ id: model.id, root: model.object, group: model.kind === "primitive" ? "primitive" : "model" }));
  const hasModels = objects.some((object) => object.group === "model");
  const hasPrimitives = objects.some((object) => object.group === "primitive");
  const rules: SpatialRule[] = [];
  if (hasModels) rules.push({ kind: "clearance-height", id: "model-height", label: "模型限高", targets: "model", maxHeightMetres: heightLimit });
  if (hasPrimitives) rules.push({ kind: "clearance-height", id: "primitive-height", label: "基础元素限高", targets: "primitive", maxHeightMetres: heightLimit });
  if (hasModels && hasPrimitives) {
    rules.unshift(
      { kind: "hard-collision", id: "model-primitive-collision", label: "模型与基础元素碰撞", groupA: "model", groupB: "primitive" },
      { kind: "clearance", id: "model-primitive-clearance", label: "模型与基础元素净空", groupA: "model", groupB: "primitive", minimumMetres: minimumClearance },
    );
  }
  const qtoLineObjects: Record<string, string[]> = {};
  const qtoInputs = models.map((model) => {
    const category = applyQtoCategoryMapping(model, qtoMappings) ?? inferCategory(model);
    const level = inferLevel(model);
    const key = `${category}∥${level}`;
    (qtoLineObjects[key] ??= []).push(model.id);
    return { id: model.id, root: model.object, category, level };
  });
  return { spatial: runSpatialValidation(objects, rules), qto: buildQtoReport(qtoInputs), qtoLineObjects };
}

function inferCategory(model: LoadedSceneModel): string {
  const value = model.object.userData.category ?? model.object.userData.categoryName ?? model.object.userData.ifcType ?? model.object.userData.type;
  return typeof value === "string" && value.trim() ? value.trim() : model.kind === "primitive" ? "基础元素" : "模型";
}

function inferLevel(model: LoadedSceneModel): string {
  const value = model.object.userData.level ?? model.object.userData.levelName ?? model.object.userData.storey;
  return typeof value === "string" && value.trim() ? value.trim() : "未分层";
}

function safeFileStem(value: string): string { return value.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").trim() || "scene"; }
function validNonNegative(value: string, fallback: number): number { const parsed = Number(value); return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback; }
function validPositive(value: string, fallback: number): number { const parsed = Number(value); return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback; }
