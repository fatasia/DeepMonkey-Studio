import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { AlertTriangle, Box, CheckCircle2, Download, LoaderCircle, Play, Save, Sparkles, WandSparkles, X } from "lucide-react";
import { PARAMETRIC_CAD_TEMPLATES } from "@bim-studio/parametric-modeling-plugin";
import type { AppLocale } from "../i18n";
import { translate as tr } from "../i18n";
import { ParametricBindingEditor } from "./ParametricBindingEditor";
import { ParametricModelPreview } from "./ParametricModelPreview";
import { downloadParametricStep } from "./parametricGlb";
import { useParametricWorkbench, type ParametricWorkbenchOptions } from "./useParametricWorkbench";
import Modeling3dPanel from "./Modeling3dPanel";
import { api } from "../api";
import "./ParametricModelWorkbench.css";

type GenerationMode = "parametric" | "tripo3d" | "tencentHunyuan";
const GENERATION_MODES: GenerationMode[] = ["parametric", "tripo3d", "tencentHunyuan"];

export function parametricModeForTabKey(current: GenerationMode, key: string): GenerationMode | undefined {
  if (key === "Home") return "parametric";
  if (key === "End") return "tencentHunyuan";
  const index = GENERATION_MODES.indexOf(current);
  if (["ArrowRight", "ArrowDown"].includes(key)) return GENERATION_MODES[(index + 1) % GENERATION_MODES.length];
  if (["ArrowLeft", "ArrowUp"].includes(key)) return GENERATION_MODES[(index - 1 + GENERATION_MODES.length) % GENERATION_MODES.length];
}

export default function ParametricModelWorkbench(props: ParametricWorkbenchOptions & { locale: AppLocale; embedded?: boolean }) {
  const { locale } = props;
  const state = useParametricWorkbench(props);
  const dialog = useRef<HTMLDialogElement>(null);
  const parametricTab = useRef<HTMLButtonElement>(null);
  const tripoTab = useRef<HTMLButtonElement>(null);
  const hunyuanTab = useRef<HTMLButtonElement>(null);
  const [mode, setMode] = useState<GenerationMode>("parametric");
  const busy = state.phase !== "idle";
  const canSave = state.current && state.validation.valid && !busy;
  useEffect(() => {
    if (props.embedded) return;
    const element = dialog.current;
    const previous = document.activeElement;
    element?.showModal();
    return () => { element?.close(); if (previous instanceof HTMLElement) previous.focus(); };
  }, [props.embedded]);
  const status = state.phase === "drafting" ? tr(locale, "正在生成设计…", "Creating design…")
    : state.phase === "building" ? tr(locale, "正在生成几何预览…", "Building geometry…")
    : state.phase === "saving" ? tr(locale, "正在保存资源…", "Saving asset…")
    : state.phase === "downloading" ? tr(locale, "正在导出 GLB…", "Exporting GLB…")
    : state.result && !state.current ? tr(locale, "参数已修改，请更新预览", "Parameters changed · update preview")
    : state.notice === "已取消" ? tr(locale, "已取消", "Cancelled")
    : state.current ? tr(locale, "预览已就绪", "Preview ready") : tr(locale, "选择样例或描述要创建的部件", "Choose an example or describe a part");

  function handleTabKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    const next = parametricModeForTabKey(mode, event.key);
    if (!next) return;
    event.preventDefault();
    setMode(next);
    (next === "parametric" ? parametricTab : next === "tripo3d" ? tripoTab : hunyuanTab).current?.focus();
  }

  return <dialog className={`parametric-workbench${props.embedded ? " parametric-workbench-page" : ""}`} ref={dialog} open={props.embedded || undefined} aria-labelledby="parametric-title"
    onCancel={(event) => { event.preventDefault(); state.close(); }}
    onClick={(event) => { if (event.target === event.currentTarget) state.close(); }}>
    <header>
      <WandSparkles size={20} />
      <div>
        <h2 id="parametric-title">{tr(locale, "模型生成", "Model generation")}</h2>
        <div className="parametric-mode-tabs" role="tablist" aria-label={tr(locale, "生成模式", "Generation mode")}>
          <button ref={parametricTab} id="parametric-mode-tab" type="button" role="tab" aria-controls="parametric-mode-panel" aria-selected={mode === "parametric"} tabIndex={mode === "parametric" ? 0 : -1} className={mode === "parametric" ? "active" : ""} onKeyDown={handleTabKeyDown} onClick={() => setMode("parametric")}>{tr(locale, "参数生成", "Parametric")}</button>
          <button ref={tripoTab} id="tripo-mode-tab" type="button" role="tab" aria-controls="ai-mode-panel" aria-selected={mode === "tripo3d"} tabIndex={mode === "tripo3d" ? 0 : -1} className={mode === "tripo3d" ? "active" : ""} onKeyDown={handleTabKeyDown} onClick={() => setMode("tripo3d")}>Tripo3D</button>
          <button ref={hunyuanTab} id="hunyuan-mode-tab" type="button" role="tab" aria-controls="ai-mode-panel" aria-selected={mode === "tencentHunyuan"} tabIndex={mode === "tencentHunyuan" ? 0 : -1} className={mode === "tencentHunyuan" ? "active" : ""} onKeyDown={handleTabKeyDown} onClick={() => setMode("tencentHunyuan")}>{tr(locale, "混元 3D", "Hunyuan 3D")}</button>
        </div>
      </div>
      {props.sourceModel?.generation?.kind === "parametric" && <span>v{props.sourceModel.generation.revision} → v{props.sourceModel.generation.revision + 1}</span>}
      <button type="button" className="parametric-close" aria-label={tr(locale, "关闭建模", "Close modeling")} disabled={state.phase === "saving"} onClick={state.close}><X size={18} /></button>
    </header>
    <div id="parametric-mode-panel" className="parametric-body mode-parametric" role="tabpanel" aria-labelledby="parametric-mode-tab" aria-busy={busy || undefined} hidden={mode !== "parametric"}>
      <aside className="parametric-create">
        <div className="parametric-language-create">
          <textarea aria-label={tr(locale, "模型语言描述", "Model description")} maxLength={4000} value={state.prompt} disabled={busy} onChange={(event) => state.setPrompt(event.target.value)} placeholder={tr(locale, "描述部件与尺寸，例如：160×90mm、四孔安装板", "Describe the part and dimensions")} />
          <button className="parametric-primary" disabled={busy || state.prompt.trim().length < 3} onClick={() => void state.generate("ai")}><Sparkles size={14} />{tr(locale, "生成参数", "Generate parameters")}</button>
        </div>
        <div className="parametric-section-title"><h3>{tr(locale, "样例", "Examples")}</h3></div>
        <div className="parametric-templates">
          {PARAMETRIC_CAD_TEMPLATES.map((template, index) => <button type="button" key={template.id} disabled={busy} aria-pressed={state.templateId === template.id} onClick={() => void state.generate("template", template)}>
            <span className={`parametric-template-shape shape-${index}`} aria-hidden="true"><Box size={22} /></span>
            <span><strong>{template.label}</strong><small>{template.description}</small></span>
          </button>)}
        </div>
      </aside>
      <section className="parametric-output" aria-label={tr(locale, "模型预览", "Model preview")}>
        <ParametricModelPreview result={state.result} locale={locale} />
        <div className={`parametric-preview-status${busy ? " busy" : ""}`} role="status" aria-live="polite">
          {busy ? <LoaderCircle className="spin" size={16} /> : state.current ? <CheckCircle2 size={16} /> : <Box size={16} />}{status}
        </div>
        {state.result && <div className="parametric-stats">
          <span><small>{tr(locale, "体积", "Volume")}</small><strong>{number(state.result.summary.volumeMm3, locale)} <em>mm³</em></strong></span>
          <span><small>{tr(locale, "三角面", "Triangles")}</small><strong>{number(state.result.summary.triangleCount, locale)}</strong></span>
          <span><small>{tr(locale, "计算耗时", "Build time")}</small><strong>{number(state.result.summary.durationMs, locale)} <em>ms</em></strong></span>
        </div>}
        {state.error && <div className="parametric-error" role="alert"><AlertTriangle size={16} /><span>{state.error}</span></div>}
        {!!state.result?.summary.warnings.length && <details className="parametric-build-warnings"><summary>{tr(locale, "几何处理提示", "Geometry notes")}</summary>{state.result.summary.warnings.map((warning) => <p key={warning}>{warning}</p>)}</details>}
      </section>
      <aside className="parametric-parameters" aria-label={tr(locale, "参数配置", "Parameters")}>
        <fieldset disabled={busy}>
          <label className="parametric-name"><span>{tr(locale, "资源名称", "Asset name")}</span><input value={state.definition.name} maxLength={120} onChange={(event) => state.change({ ...state.definition, name: event.target.value })} /></label>
          <div className="parametric-section-title"><h3>{tr(locale, "尺寸参数", "Dimensions")}</h3></div>
          <div className="parametric-parameter-list">{state.definition.parameters.map((parameter, index) => <div key={parameter.id}>
            <label><span>{parameter.label}<small className="parametric-unit"> {parameter.unit === "count" ? tr(locale, "个", "count") : parameter.unit}</small></span><input type="number" aria-label={parameter.label} min={parameter.min} max={parameter.max} step={parameter.step} value={Number.isNaN(parameter.value) ? "" : parameter.value} onChange={(event) => update(index, event.target.valueAsNumber)} /></label>
            <input type="range" aria-label={`${parameter.label} ${tr(locale, "滑块", "slider")}`} min={parameter.min} max={parameter.max} step={parameter.step} value={Number.isFinite(parameter.value) ? parameter.value : parameter.min} onChange={(event) => update(index, event.target.valueAsNumber)} />
          </div>)}</div>
          {!state.validation.valid && <p className="parametric-error" role="alert"><AlertTriangle size={15} />{state.validation.issues[0]?.message}</p>}
          <ParametricBindingEditor locale={locale} definition={state.definition} sources={state.bindingSources} onChange={state.updateBinding} />
        </fieldset>
      </aside>
    </div>
    <div id="ai-mode-panel" className="parametric-body mode-ai" role="tabpanel" aria-labelledby={mode === "tripo3d" ? "tripo-mode-tab" : "hunyuan-mode-tab"} hidden={mode === "parametric"}>
      <section className="parametric-ai-surface" aria-label={tr(locale, "AI 生成", "AI generation")}>
        {mode !== "parametric" && <Modeling3dPanel key={mode} locale={locale} provider={mode} onImport={async (modelUrl, provider) => {
          const blob = await api.downloadExternalModel(modelUrl);
          const model = await api.uploadModel(props.projectId, new File([blob], `${provider}-${Date.now()}.glb`, { type: "model/gltf-binary" }));
          await props.onSaved(model);
        }} />}
      </section>
    </div>
    <footer hidden={mode !== "parametric"}>
      <div>
        {busy && state.phase !== "saving" && <button type="button" onClick={state.cancel}>{tr(locale, "取消生成", "Cancel generation")}</button>}
        <button type="button" disabled={!canSave} title={!canSave ? tr(locale, "先生成与当前参数一致的预览", "Build a preview matching the current parameters first") : undefined} onClick={() => state.result && downloadParametricStep(state.result.step, state.definition.name)}><Download size={15} />STEP</button>
        <button type="button" disabled={!canSave} title={!canSave ? tr(locale, "先生成与当前参数一致的预览", "Build a preview matching the current parameters first") : undefined} onClick={() => void state.downloadGlb()}><Download size={15} />GLB</button>
        <button type="button" disabled={busy || !state.validation.valid} onClick={() => void state.generate("template")}><Play size={15} />{tr(locale, "更新预览", "Update preview")}</button>
        <button type="button" className={canSave ? "parametric-primary" : ""} disabled={!canSave} title={!canSave ? tr(locale, "生成有效预览后保存", "Generate a valid preview to save") : undefined} onClick={() => void state.save()}><Save size={15} />{state.phase === "saving" ? tr(locale, "保存中…", "Saving…") : tr(locale, "保存到资源", "Save to assets")}</button>
      </div>
    </footer>
  </dialog>;

  function update(index: number, value: number) {
    const next = structuredClone(state.definition);
    next.parameters[index]!.value = value;
    state.change(next);
  }
}
function number(value: number, locale: AppLocale): string { return new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(value); }
