import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { DataDatasetRecord, DataWritebackConfig, DataWritebackField } from "@bim-studio/contracts";
import { api } from "../api";
import { translate as tr, type AppLocale } from "../i18n";
import { createWritebackDraft, prepareWritebackDraft } from "./dashboardWritebackDraft";
import { DatasetWritebackSession } from "./datasetWritebackSession";
import { readWritebackDraft, saveWritebackDraft, writebackDraftKey } from "./datasetWritebackDraftCache";
import "./DatasetWritebackPanel.css";

export function DatasetWritebackPanel({ locale, projectId, userId, dataset, canWrite }: {
  locale: AppLocale; projectId: string; userId: string; dataset: DataDatasetRecord & { writeback: DataWritebackConfig }; canWrite: boolean;
}) {
  const cacheKey = writebackDraftKey(userId, projectId, dataset.id);
  const cached = useMemo(() => {
    try { return readWritebackDraft(sessionStorage, cacheKey, dataset.writeback); } catch { return undefined; }
  }, [cacheKey, dataset.writeback]);
  const session = useMemo(() => new DatasetWritebackSession(dataset.writeback, {
    read: (id, signal) => api.readDatasetRecord(projectId, dataset.id, id, signal),
    write: (id, changes, signal) => api.writeDatasetRecord(projectId, dataset.id, id, changes, signal),
  }, cached), [projectId, dataset.id, dataset.writeback, cached]);
  useEffect(() => () => session.dispose(), [session]);
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
  const [recordId, setRecordId] = useState(cached?.recordId ?? "");
  const [cacheError, setCacheError] = useState(false);
  useEffect(() => {
    try { setCacheError(!saveWritebackDraft(sessionStorage, cacheKey, dataset.writeback, state)); }
    catch { setCacheError(true); }
  }, [cacheKey, dataset.writeback, state]);
  const [replacement, setReplacement] = useState<string>();
  const busy = state.phase === "loading" || state.phase === "writing";
  const original = state.baseline ? createWritebackDraft(dataset.writeback, state.baseline) : {};
  const dirty = dataset.writeback.fields.some(field => state.draft[field.key] !== original[field.key]);
  const values = prepareWritebackDraft(dataset.writeback, state.draft).values;
  const changed = dataset.writeback.fields.filter(field => values[field.key] !== state.baseline?.values[field.key]);
  function openRecord() {
    if (state.baseline && (dirty || state.needsReconcile)) { setReplacement(recordId.trim()); return; }
    void session.read(recordId.trim());
  }
  return <section className="dataset-writeback" aria-label={tr(locale, "业务填报", "Record entry")}>
    <header><strong>{tr(locale, "业务填报", "Record entry")}</strong></header>
    <div className="dataset-writeback-record">
      <label>{tr(locale, "记录编号", "Record ID")}<input value={recordId} maxLength={128} disabled={busy} onChange={event => setRecordId(event.target.value)} /></label>
      <button type="button" disabled={busy || !recordId.trim()} onClick={openRecord}>{tr(locale, "读取记录", "Load record")}</button>
    </div>
    {replacement !== undefined && <div className="dataset-writeback-notice" role="alert">
      <span>{tr(locale, "重新读取会放弃当前未提交修改。", "Loading discards the current unsaved changes.")}</span>
      <button onClick={() => { void session.read(replacement); setReplacement(undefined); }}>{tr(locale, "放弃并读取", "Discard and load")}</button>
      <button onClick={() => setReplacement(undefined)}>{tr(locale, "取消", "Cancel")}</button>
    </div>}
    {state.error && <p role="alert">{state.error}</p>}
    {cacheError && <p role="alert">{tr(locale, "浏览器无法暂存草稿，请勿刷新或关闭页面。", "Draft storage is unavailable. Do not refresh or close this page.")}</p>}
    {state.saved && <p role="status">{tr(locale, "记录已写入", "Record saved")}</p>}
    {busy && <p role="status">{state.phase === "writing" ? tr(locale, "正在写入…", "Saving…") : tr(locale, "正在读取…", "Loading…")}</p>}
    {state.baseline && <>
      <fieldset disabled={!canWrite || busy || state.phase === "confirming" || state.needsReconcile}>
        <legend>{state.recordId}</legend>
        {dataset.writeback.fields.map(field => <label key={field.key}>
          <span>{field.key}{field.required ? " *" : ""}</span>
          <RecordField field={field} value={state.draft[field.key] ?? ""} onChange={value => session.edit(field.key, value)} />
          {state.issues.filter(issue => issue.field === field.key).map(issue => <small role="alert" key={issue.message}>{issue.message}</small>)}
        </label>)}
      </fieldset>
      {state.needsReconcile && <div className="dataset-writeback-notice">
        <button disabled={busy} onClick={() => void session.read(state.recordId, true)}>{tr(locale, "重新读取并核对", "Read latest and compare")}</button>
        {state.remote && <>
          <div className="dataset-writeback-table"><table><thead><tr><th>{tr(locale, "字段", "Field")}</th><th>{tr(locale, "我的值", "My value")}</th><th>{tr(locale, "当前记录", "Current record")}</th></tr></thead>
            <tbody>{dataset.writeback.fields.map(field => <tr key={field.key}><th>{field.key}</th><td>{display(values[field.key])}</td><td>{display(state.remote!.values[field.key])}</td></tr>)}</tbody></table></div>
          <button disabled={busy} onClick={() => session.resolveRemote(false)}>{tr(locale, "采用当前记录", "Use current record")}</button>
          {canWrite && <button disabled={busy} onClick={() => session.resolveRemote(true)}>{tr(locale, "保留我的修改并重新确认", "Keep my edits and review again")}</button>}
        </>}
      </div>}
      {state.phase === "confirming" ? <div className="dataset-writeback-confirm">
        <div className="dataset-writeback-table"><table><thead><tr><th>{tr(locale, "字段", "Field")}</th><th>{tr(locale, "原值", "Before")}</th><th>{tr(locale, "提交值", "After")}</th></tr></thead>
          <tbody>{changed.map(field => <tr key={field.key}><th>{field.key}</th><td>{display(state.baseline!.values[field.key])}</td><td>{display(values[field.key])}</td></tr>)}</tbody></table></div>
        <button onClick={() => session.cancelReview()}>{tr(locale, "返回修改", "Edit")}</button>
        <button className="primary" disabled={!canWrite || changed.length === 0} onClick={() => void session.submit()}>{tr(locale, "确认写入", "Confirm save")}</button>
      </div> : <button className="primary" disabled={!canWrite || busy || !dirty || state.needsReconcile} title={!canWrite ? tr(locale, "当前账号只读", "This account is read-only") : undefined} onClick={() => session.review()}>{tr(locale, "检查并提交", "Review changes")}</button>}
    </>}
  </section>;
}

function display(value: unknown) { return value == null ? "—" : String(value); }
function RecordField({ field, value, onChange }: { field: DataWritebackField; value: string; onChange(value: string): void }) {
  if (field.options || field.type === "boolean") {
    const options = field.options ?? [true, false];
    return <select value={value} onChange={event => onChange(event.target.value)} required={field.required}>
      <option value="">—</option>{options.filter(option => option !== null && option !== "").map(option => <option key={String(option)} value={String(option)}>{String(option)}</option>)}
    </select>;
  }
  return <input type={field.type === "number" ? "number" : field.type === "date" ? "date" : "text"} step={field.type === "number" ? "any" : undefined}
    required={field.required} min={field.min} max={field.max} maxLength={field.maxLength ?? 4096} value={value} onChange={event => onChange(event.target.value)} />;
}
