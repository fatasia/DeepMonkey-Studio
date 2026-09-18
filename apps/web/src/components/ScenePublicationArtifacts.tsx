import { useEffect, useRef, useState } from "react";
import { CircleCheck, CircleX, Clock3, Download, LoaderCircle, RotateCcw, X } from "lucide-react";
import type { useScenePublicationArtifacts } from "../hooks/useScenePublicationArtifacts";
import type { SceneArtifactRecord } from "../controllers/scenePublicationArtifactRecord";
import { translate as tr, type AppLocale } from "../i18n";
import "./ScenePublicationArtifacts.css";

export interface ScenePublicationArtifactsProps {
  artifacts: ReturnType<typeof useScenePublicationArtifacts>;
  projectId: string;
  sceneId: string;
  locale: AppLocale;
}

/** 原发布版本的打包任务；滚动由发布弹窗提供，历史任务按需展开。 */
export function ScenePublicationArtifacts({ artifacts, projectId, sceneId, locale }: ScenePublicationArtifactsProps) {
  const [localError, setLocalError] = useState<string>();
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const inflight = useRef(new Set<string>());
  const generation = useRef(0);
  const scope = JSON.stringify([projectId, sceneId]);
  const currentScope = useRef(scope); currentScope.current = scope;
  const { load } = artifacts;
  const describeError = (reason: unknown) => reason instanceof Error ? reason.message : String(reason);

  async function reload() {
    const request = generation.current;
    setLocalError(undefined);
    try { await load(projectId, sceneId); }
    catch (reason) { if (currentScope.current === scope && generation.current === request) setLocalError(describeError(reason)); }
  }
  useEffect(() => {
    currentScope.current = scope;
    generation.current++;
    setPending(new Set(inflight.current));
    void reload();
    return () => { currentScope.current = ""; generation.current++; };
  }, [load, projectId, sceneId]);

  async function retry(record: SceneArtifactRecord) {
    const request = generation.current;
    if (inflight.current.has(record.key)) return;
    inflight.current.add(record.key); setPending(new Set(inflight.current)); setLocalError(undefined);
    try { await artifacts.retry(record); }
    catch (reason) { if (currentScope.current === scope && generation.current === request) setLocalError(describeError(reason)); }
    finally {
      inflight.current.delete(record.key);
      if (currentScope.current === scope && generation.current === request) setPending(new Set(inflight.current));
    }
  }
  function cancel(record: SceneArtifactRecord) {
    try { artifacts.cancel(record.key); }
    catch (reason) { setLocalError(describeError(reason)); }
  }
  const records = artifacts.records.filter((record) => record.projectId === projectId && record.sceneId === sceneId);
  const error = localError ?? artifacts.error;
  const row = (record: SceneArtifactRecord) => {
    const running = record.status === "preparing" || record.status === "building" || pending.has(record.key);
    const state = running ? (record.status === "building" ? "building" : "preparing") : record.status;
    const Icon = running ? LoaderCircle : state === "ready" ? CircleCheck : state === "failed" ? CircleX : Clock3;
    const labels = { preparing: tr(locale, "准备中", "Preparing"), building: tr(locale, "打包中", "Building"),
      ready: tr(locale, "已生成", "Ready"), failed: tr(locale, "失败", "Failed"), cancelled: tr(locale, "已取消", "Cancelled") };
    const action = running ? tr(locale, "取消打包", "Cancel build") : state === "ready" ? tr(locale, "再次下载", "Download again") : tr(locale, "重试打包", "Retry build");
    return <li key={record.key} className="publication-artifact-row">
      <div className="publication-artifact-main">
        <span className={`publication-artifact-state ${state}`}><Icon size={14} aria-hidden="true" className={running ? "publication-artifact-spinner" : undefined} />{labels[state]}</span>
        <strong>{tr(locale, "版本", "Version")} {record.publicationVersion} · {record.target === "deep-native" ? "Deep Native" : "Three WebView"}</strong>
        <button className="button" type="button" aria-label={`${action} · ${tr(locale, "版本", "Version")} ${record.publicationVersion} · ${record.target === "deep-native" ? "Deep Native" : "Three WebView"}`}
          onClick={() => running ? cancel(record) : void retry(record)}>
          {running ? <X size={13} aria-hidden="true" /> : state === "ready" ? <Download size={13} aria-hidden="true" /> : <RotateCcw size={13} aria-hidden="true" />}{action}
        </button>
      </div>
      {record.error && !running && <p className="publication-artifact-error">{record.error}</p>}
    </li>;
  };
  return <section className="publication-artifacts" aria-label={tr(locale, "客户端打包记录", "Client package history")}>
    <h3>{tr(locale, "客户端打包记录", "Client package history")}</h3>
    {error && <div className="publication-artifact-error" role="alert"><p>{error}</p>
      <button className="button" type="button" onClick={() => void reload()}><RotateCcw size={13} aria-hidden="true" />{tr(locale, "重新读取", "Reload records")}</button>
    </div>}
    {artifacts.loading && <p className="publication-artifact-empty" role="status">{tr(locale, "正在读取打包记录…", "Loading package records…")}</p>}
    {!records.length && !artifacts.loading && !error && <p className="publication-artifact-empty">{tr(locale, "打包后可在这里重试下载。", "Package retries will appear here.")}</p>}
    {!!records.length && <ul>{records.slice(0, 2).map(row)}</ul>}
    {records.length > 2 && <details><summary>{tr(locale, `更多记录（${records.length - 2}）`, `More records (${records.length - 2})`)}</summary><ul>{records.slice(2).map(row)}</ul></details>}
  </section>;
}
