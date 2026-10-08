import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { LoaderCircle, Save, X } from "lucide-react";
import type { OntologyPackage, OntologyRelationType } from "@bim-studio/contracts";
import { api } from "../api";
import { translate as tr, type AppLocale } from "../i18n";
import { RelationForm } from "./OntologyRelationForm";
import { applyGraphRelation } from "./ontologyGraphEditing";

export default function OntologyGraphRelationEditor({ projectId, pkg, initial, locale, onClose, onSaved }: {
  projectId: string; pkg: OntologyPackage; initial: OntologyRelationType; locale: AppLocale;
  onClose: () => void; onSaved: (saved: OntologyPackage) => void;
}) {
  const [base, setBase] = useState(pkg), [relation, setRelation] = useState(initial);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const dialog = useRef<HTMLDialogElement>(null), titleId = useId();
  const existing = pkg.relations.some(item => item.id === initial.id);
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);
  async function save() {
    setError("");
    try { applyGraphRelation(base, relation); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); return; }
    setBusy(true);
    try {
      let latest = await api.getOntologyPackage(projectId, base.id);
      if (latest.revision !== base.revision || latest.version !== base.version || latest.status !== base.status)
        throw new Error(tr(locale, "本体包已变更，请关闭配置并重新查询后编辑。", "The package changed. Close this editor, reload the graph and retry."));
      if (latest.status === "published") {
        latest = await api.cloneOntologyDraft(projectId, latest.id);
        setBase(latest);
      }
      if (latest.status !== "draft") throw new Error(tr(locale, "当前版本不可编辑，请先回到草稿。", "This version is not editable; return to a draft first."));
      const saved = await api.updateOntologyPackage(projectId, applyGraphRelation(latest, { ...relation, status: "draft" }));
      onSaved(saved);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  }
  return createPortal(<dialog ref={dialog} className="ontology-workspace ontology-relation-dialog" aria-labelledby={titleId}
    onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}>
    <header><div><h3 id={titleId}>{existing ? tr(locale, "编辑关系", "Edit relation") : tr(locale, "新建关系", "New relation")}</h3>
      <p>{base.status === "published" ? tr(locale, "保存为新草稿，发布版本保留。", "Save to a new draft; keep the published version.")
        : tr(locale, "配置两端字段、基数与证据。", "Configure endpoint fields, cardinality and evidence.")}</p></div>
      <button type="button" aria-label={tr(locale, "关闭关系配置", "Close relation editor")} disabled={busy} onClick={onClose}><X size={16} /></button></header>
    <div className="ontology-relation-dialog-body"><RelationForm value={relation} pkg={base} locale={locale} onChange={setRelation} /></div>
    {error && <p className="ontology-relation-error" role="alert">{error}</p>}
    <footer><button type="button" disabled={busy} onClick={onClose}>{tr(locale, "取消", "Cancel")}</button>
      <button type="button" className="primary" disabled={busy} onClick={() => void save()}>{busy ? <LoaderCircle className="spin" size={14} /> : <Save size={14} />}
        {base.status === "published" ? tr(locale, "保存到新草稿", "Save to new draft") : tr(locale, "保存关系", "Save relation")}</button></footer>
  </dialog>, document.body);
}
