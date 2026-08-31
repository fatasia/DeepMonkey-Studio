import { Database, FileJson2, Link2, LoaderCircle, ShieldCheck, Upload, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { proposeSmartAssetBindings, type SmartAssetBindingResult, type SmartBindingCatalogItem, type SmartBindingCandidate, type SmartBindingSceneObject } from "@bim-studio/studio-core";
import { translate as tr, type AppLocale } from "../i18n";
import type { ComponentRecord } from "../viewer/analysis";
import { SmartAssetBindingResults } from "./SmartAssetBindingResults";
import {
  assertBindingWorkload,
  componentRecordsToBindingObjects,
  MAX_BINDING_CATALOG_BYTES,
  parseSmartBindingCatalog,
  type SmartBindingCatalogFormat,
} from "./smartAssetBindingCatalog";
import {
  buildSmartBindingWorkbenchView,
  candidateKey,
  confirmedMappings,
  type ConfirmedSmartAssetMapping,
  type SmartBindingWorkbenchView,
} from "./smartAssetBindingWorkbenchModel";

interface AnalysisState {
  scenes: SmartBindingSceneObject[];
  catalog: SmartBindingCatalogItem[];
  result: SmartAssetBindingResult;
  view: SmartBindingWorkbenchView;
}

export interface SmartAssetBindingWorkbenchProps {
  locale: AppLocale;
  components: readonly ComponentRecord[];
  initialCatalogText?: string;
  onConfirm: (mappings: ConfirmedSmartAssetMapping[]) => void;
  onClose?: () => void;
}

/**
 * 设备/测点绑定校核台只产出用户明确确认的映射，不在组件内部写入场景或绑定配置。
 */
export function SmartAssetBindingWorkbench(props: SmartAssetBindingWorkbenchProps) {
  const [source, setSource] = useState(props.initialCatalogText ?? "");
  const [format, setFormat] = useState<SmartBindingCatalogFormat>("auto");
  const [analysis, setAnalysis] = useState<AnalysisState>();
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string>();
  const [analyzing, setAnalyzing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const runRevision = useRef(0);
  const sceneObjects = useMemo(() => componentRecordsToBindingObjects(props.components), [props.components]);
  const selectedMappings = analysis ? confirmedMappings(analysis.result.candidates, selectedKeys) : [];

  useEffect(() => () => { runRevision.current += 1; }, []);

  function analyze() {
    const revision = ++runRevision.current;
    setAnalyzing(true);
    setError(undefined);
    setConfirming(false);
    // 让“正在分析”先完成一次绘制，避免中等规模目录点击后没有任何反馈。
    setTimeout(() => {
      try {
        if (!sceneObjects.length) throw new Error(tr(props.locale, "场景中没有可绑定对象", "The scene has no bindable objects"));
        const catalog = parseSmartBindingCatalog(source, format);
        assertBindingWorkload(sceneObjects.length, catalog.length);
        const result = proposeSmartAssetBindings(sceneObjects, catalog);
        const view = buildSmartBindingWorkbenchView(result, sceneObjects, catalog);
        if (runRevision.current !== revision) return;
        setAnalysis({ scenes: sceneObjects, catalog, result, view });
        setSelectedKeys(new Set(view.strongCandidates.map(candidateKey)));
      } catch (reason) {
        if (runRevision.current !== revision) return;
        setAnalysis(undefined);
        setSelectedKeys(new Set());
        setError(reason instanceof Error ? reason.message : String(reason));
      } finally {
        if (runRevision.current === revision) setAnalyzing(false);
      }
    }, 0);
  }

  async function importCatalog(file: File | undefined) {
    if (!file) return;
    setAnalysis(undefined);
    setSelectedKeys(new Set());
    setConfirming(false);
    setError(undefined);
    try {
      if (file.size > MAX_BINDING_CATALOG_BYTES) throw new Error(tr(props.locale, "目录超过 5 MiB，请按区域或专业拆分后再绑定", "Catalog exceeds 5 MiB; split it by area or discipline"));
      setSource(await file.text());
      setFormat("auto");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }

  function toggleCandidate(candidate: SmartBindingCandidate, selected: boolean) {
    setConfirming(false);
    setSelectedKeys((current) => {
      const next = new Set(current);
      const key = candidateKey(candidate);
      if (selected) next.add(key);
      else next.delete(key);
      return next;
    });
  }

  function completeConfirmation() {
    if (!selectedMappings.length) return;
    props.onConfirm(selectedMappings);
    setConfirming(false);
  }

  return (
    <section
      className="smart-binding-workbench"
      role="dialog"
      aria-modal={props.onClose ? "true" : undefined}
      aria-busy={analyzing}
      aria-label={tr(props.locale, "设备与测点智能绑定", "Smart asset and point binding")}
      onMouseDown={(event) => event.stopPropagation()}
      onKeyDown={(event) => { if (event.key === "Escape" && !analyzing) props.onClose?.(); }}
    >
      <header className="smart-binding-header">
        <span className="smart-binding-title-icon"><Link2 size={18} /></span>
        <div>
          <strong>{tr(props.locale, "设备与测点智能绑定", "Smart asset and point binding")}</strong>
          <small>{tr(props.locale, "确定性多因素建议 · 人工确认 · 随场景保存", "Deterministic multi-factor proposals · Human confirmation · Saved with the scene")}</small>
        </div>
        {props.onClose && <button type="button" className="smart-binding-close" disabled={analyzing} onClick={props.onClose} aria-label={tr(props.locale, "关闭绑定工作台", "Close binding workbench")}><X size={17} /></button>}
      </header>

      <div className="smart-binding-body">
        <section className="smart-binding-source">
          <header><span><Database size={14} />{tr(props.locale, "设备/测点目录", "Device / point catalog")}</span><small>{tr(props.locale, `${props.components.length} 个场景对象`, `${props.components.length} scene objects`)}</small></header>
          <div className="smart-binding-source-actions">
            <label className="smart-binding-file">
              <Upload size={13} /><span>{tr(props.locale, "导入 JSON / CSV", "Import JSON / CSV")}</span>
              <input type="file" accept=".json,.csv,.tsv,application/json,text/csv,text/tab-separated-values" onChange={(event) => void importCatalog(event.target.files?.[0])} />
            </label>
            <label>
              <span>{tr(props.locale, "格式", "Format")}</span>
              <select value={format} onChange={(event) => setFormat(event.target.value as SmartBindingCatalogFormat)}>
                <option value="auto">{tr(props.locale, "自动识别", "Auto detect")}</option>
                <option value="json">JSON</option>
                <option value="csv">CSV / TSV</option>
              </select>
            </label>
          </div>
          <textarea
            value={source}
            spellCheck={false}
            onChange={(event) => { setSource(event.target.value); setAnalysis(undefined); setSelectedKeys(new Set()); setConfirming(false); }}
            aria-label={tr(props.locale, "设备与测点目录内容", "Device and point catalog content")}
            placeholder={tr(props.locale, "粘贴 JSON 数组，或含表头的 CSV / TSV…", "Paste a JSON array or CSV / TSV with headers…")}
          />
          <small>{tr(props.locale, "必填：deviceId/设备编号、name/设备名称；可选：tags、space、category、X/Y/Z。", "Required: deviceId and name. Optional: tags, space, category and X/Y/Z.")}</small>
          <details className="smart-binding-format-help">
            <summary>{tr(props.locale, "查看最小格式示例", "View minimal format example")}</summary>
            <pre>{tr(props.locale, "设备编号,设备名称,区域,类别\nP-001,循环泵,A区,泵", "deviceId,name,space,category\nP-001,Circulation pump,Area A,Pump")}</pre>
          </details>
          <button type="button" className="button primary smart-binding-analyze" disabled={analyzing || !source.trim() || props.components.length === 0} onClick={analyze}>
            {analyzing ? <LoaderCircle className="spin" size={14} /> : <FileJson2 size={14} />}
            {analyzing ? tr(props.locale, "正在生成候选…", "Generating candidates…") : tr(props.locale, "分析匹配", "Analyze matches")}
          </button>
          {props.components.length === 0 && <div className="smart-binding-notice">{tr(props.locale, "先导入模型或创建设备对象，再进行目录绑定。", "Import a model or create device objects before catalog binding.")}</div>}
          {error && <div className="smart-binding-error" role="alert">{error}</div>}
        </section>

        <section className="smart-binding-review" aria-live="polite">
          {analysis ? (
            <SmartAssetBindingResults locale={props.locale} view={analysis.view} selectedKeys={selectedKeys} onToggle={toggleCandidate} />
          ) : (
            <div className="smart-binding-empty">
              <ShieldCheck size={25} />
              <strong>{tr(props.locale, "导入目录后开始校核", "Import a catalog to begin review")}</strong>
              <small>{tr(props.locale, "系统只生成可解释候选；低置信、冲突与未匹配会分开呈现。", "The system only proposes explainable candidates; low-confidence, conflict and unmatched records remain separate.")}</small>
            </div>
          )}
        </section>
      </div>

      <footer className="smart-binding-footer">
        <span>{tr(props.locale, `已选择 ${selectedMappings.length} 条`, `${selectedMappings.length} selected`)}</span>
        {confirming ? (
          <div className="smart-binding-confirmation">
            <small>{tr(props.locale, "只保存明确选择的映射，未选候选不会写入。", "Only explicitly selected mappings are saved; unselected candidates are not written.")}</small>
            <button type="button" className="button" onClick={() => setConfirming(false)}>{tr(props.locale, "返回复核", "Back to review")}</button>
            <button type="button" className="button primary" onClick={completeConfirmation}><ShieldCheck size={13} />{tr(props.locale, `确认 ${selectedMappings.length} 条映射`, `Confirm ${selectedMappings.length} mappings`)}</button>
          </div>
        ) : (
          <button type="button" className="button primary" disabled={!selectedMappings.length || analyzing} onClick={() => setConfirming(true)}><ShieldCheck size={13} />{tr(props.locale, "进入确认", "Review confirmation")}</button>
        )}
      </footer>
    </section>
  );
}
