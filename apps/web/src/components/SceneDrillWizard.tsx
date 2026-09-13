import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowRight, CheckCircle2, Play, RotateCcw, WandSparkles, X } from "lucide-react";
import type { SceneInteractionScriptState } from "@bim-studio/contracts";
import type { InteractionChoiceOption, InteractionTargetOption } from "./InteractionEditor";
import type { AppLocale } from "../i18n";
import { translate as tr } from "../i18n";
import { applySceneDrills, createSceneDrill, drillConflict, drillDestinations, savedDrillDestination, suggestSceneDrills, undoSceneDrills } from "../studio/sceneDrillAuthoring";
import "./SceneDrillWizard.css";

export interface SceneDrillWizardProps {
  locale: AppLocale;
  sceneId: string;
  sceneName: string;
  sources: InteractionTargetOption[];
  scenes: InteractionChoiceOption[];
  cameras: InteractionChoiceOption[];
  interactions: SceneInteractionScriptState[];
  onChange: (items: SceneInteractionScriptState[]) => void;
  onPreview: (item: SceneInteractionScriptState) => void;
  onClose: () => void;
}

/** 只生成现有场景事件；无需另建一套空间导航运行时。 */
export function SceneDrillWizard(props: SceneDrillWizardProps) {
  const { locale } = props;
  const dialog = useRef<HTMLDialogElement>(null);
  const destinations = useMemo(() => drillDestinations(props.sceneId, props.scenes, props.cameras), [props.sceneId, props.scenes, props.cameras]);
  const suggestions = useMemo(() => suggestSceneDrills(props.sources, destinations), [props.sources, destinations]);
  const [choices, setChoices] = useState<Record<string, string>>({});
  const [search, setSearch] = useState("");
  const [added, setAdded] = useState<SceneInteractionScriptState[]>([]);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const applying = useRef(false);
  const rows = suggestions.map((row) => ({ ...row, destinationKey: savedDrillDestination(row.source, props.interactions) ?? choices[row.key] ?? row.destinationKey }));
  const filtered = rows.filter((row) => row.source.label.toLowerCase().includes(search.trim().toLowerCase()));
  const [page, setPage] = useState(0);
  const visible = filtered.slice(page * 12, page * 12 + 12);
  const eligible = rows.filter((row) => row.destinationKey && !drillConflict(row.source, props.interactions));
  useEffect(() => {
    const element = dialog.current;
    const previous = document.activeElement;
    element?.showModal();
    return () => { element?.close(); if (previous instanceof HTMLElement) previous.focus(); };
  }, []);

  function generate() {
    if (applying.current) return;
    applying.current = true;
    try {
      const batch = applySceneDrills(rows, destinations, props.interactions);
      props.onChange(batch.next);
      setAdded((current) => [...current, ...batch.added]);
      setNotice(tr(locale, `已生成 ${batch.added.length} 个钻取入口${batch.skipped ? `，${batch.skipped} 个已有事件未覆盖` : ""}`, `Created ${batch.added.length} drill entries${batch.skipped ? `; preserved ${batch.skipped} existing events` : ""}`));
      setError("");
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { applying.current = false; }
  }

  function undo() {
    const next = undoSceneDrills(props.interactions, added);
    props.onChange(next);
    const count = props.interactions.length - next.length;
    setNotice(tr(locale, `已撤销 ${count} 个入口；后续手动编辑保持不变`, `Undid ${count} entries; later manual edits were preserved`));
    setAdded([]);
  }

  return <dialog className="scene-drill-wizard" ref={dialog} aria-labelledby="scene-drill-title" onCancel={(event) => { event.preventDefault(); props.onClose(); }}>
    <header><WandSparkles size={19} /><div><h2 id="scene-drill-title">{tr(locale, "钻取向导", "Drill-down guide")}</h2><span>{props.sceneName}</span></div><button type="button" aria-label={tr(locale, "关闭钻取向导", "Close drill-down guide")} onClick={props.onClose}><X size={18} /></button></header>
    <div className="scene-drill-content">
      <nav aria-label={tr(locale, "空间钻取层级", "Spatial hierarchy")} className="scene-drill-levels">{[tr(locale, "园区", "Campus"), tr(locale, "楼栋", "Building"), tr(locale, "楼层", "Floor"), tr(locale, "设备", "Equipment")].map((level, index) => <span key={level}>{index > 0 && <ArrowRight size={14} />}<strong>{level}</strong></span>)}</nav>
      <p>{tr(locale, "匹配当前场景的入口对象与下一级空间。选择已有场景或楼层视角；设备可直接进入近景。", "Match entry objects to the next spatial level. Choose an existing scene or floor view; equipment can open a close-up.")}</p>
      <label className="scene-drill-search"><input aria-label={tr(locale, "筛选入口对象", "Filter entry objects")} placeholder={tr(locale, "搜索楼栋、楼层或设备", "Search buildings, floors or equipment")} value={search} onChange={(event) => { setSearch(event.target.value); setPage(0); }} /><span>{filtered.length} {tr(locale, "个对象", "objects")}</span></label>
      {rows.length === 0 ? <div className="scene-drill-empty">{tr(locale, "场景中还没有入口对象。先添加楼栋模型或设备，再创建钻取。", "Add a building model or equipment to this scene before creating drill entries.")}</div> : filtered.length === 0 ? <div className="scene-drill-empty">{tr(locale, "没有匹配的入口对象，请调整搜索内容。", "No matching entry objects. Try another search.")}</div> : <div className="scene-drill-entries">{visible.map((row) => {
        const conflict = drillConflict(row.source, props.interactions);
        const destination = destinations.find((item) => item.key === row.destinationKey);
        return <article key={row.key}>
          <div><strong title={row.source.label}>{row.source.label}</strong><small>{conflict ? tr(locale, "已有点击事件", "Click event exists") : row.reason === "matched" && !(row.key in choices) ? tr(locale, "已匹配同名空间", "Matching space found") : tr(locale, "选择下一级空间", "Choose the next level")}</small></div>
          <ArrowRight size={16} aria-hidden="true" />
          <select aria-label={`${row.source.label} ${tr(locale, "进入空间", "destination")}`} title={conflict ? tr(locale, "请在对象的行为面板编辑或启用已有点击事件", "Edit or enable the existing click event in the object's behavior panel") : undefined} value={row.destinationKey} disabled={conflict} onChange={(event) => setChoices((current) => ({ ...current, [row.key]: event.target.value }))}>
            <option value="">{tr(locale, "暂不生成", "Skip for now")}</option>
            <optgroup label={tr(locale, "楼栋 / 楼层场景", "Building / floor scenes")}>{destinations.filter((item) => item.key.startsWith("scene:")).map((item) => <option key={item.key} value={item.key}>{item.name}</option>)}</optgroup>
            <optgroup label={tr(locale, "已保存的空间视角", "Saved spatial views")}>{destinations.filter((item) => item.key.startsWith("camera:")).map((item) => <option key={item.key} value={item.key}>{item.name}</option>)}</optgroup>
            <option value="focus">{tr(locale, "设备近景", "Equipment close-up")}</option>
          </select>
          <button type="button" disabled={!destination} title={destination?.action.type === "navigateScene" ? tr(locale, "在新标签页浏览目标场景", "View target scene in a new tab") : tr(locale, "在当前场景预览", "Preview in this scene")} aria-label={`${tr(locale, "预览", "Preview")} ${row.source.label}`} onClick={() => {
            if (!destination) return;
            const script = createSceneDrill(row, destination);
            if (script.actions?.[0]?.type === "navigateScene") script.actions[0].newTab = true;
            else props.onClose();
            props.onPreview(script);
          }}><Play size={15} /></button>
        </article>;
      })}</div>}
      {filtered.length > 12 && <div className="scene-drill-pagination"><button type="button" disabled={page === 0} onClick={() => setPage((value) => value - 1)}>{tr(locale, "上一页", "Previous")}</button><span>{page + 1} / {Math.ceil(filtered.length / 12)}</span><button type="button" disabled={(page + 1) * 12 >= filtered.length} onClick={() => setPage((value) => value + 1)}>{tr(locale, "下一页", "Next")}</button></div>}
      {notice && <p className="scene-drill-success" role="status"><CheckCircle2 size={16} />{notice}</p>}
      {error && <p className="scene-drill-error" role="alert">{error}</p>}
    </div>
    <footer><span>{tr(locale, `待生成 ${eligible.length} 个入口`, `${eligible.length} entries ready`)}</span><div><button type="button" disabled={added.length === 0} onClick={undo}><RotateCcw size={15} />{tr(locale, "撤销本批", "Undo batch")}</button><button type="button" className="scene-drill-generate" disabled={eligible.length === 0} onClick={generate}><WandSparkles size={15} />{tr(locale, "生成钻取", "Create drill-down")}</button></div></footer>
  </dialog>;
}
