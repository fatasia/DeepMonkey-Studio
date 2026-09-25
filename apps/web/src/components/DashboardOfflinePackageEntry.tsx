import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { LoaderCircle, Package, X } from "lucide-react";
import { translate as tr, type AppLocale } from "../i18n";
import { api } from "../api";
import { useDialogEscape } from "../hooks/useGlobalDialogEscape";
import { useDashboardWorkspace } from "./dashboardWorkspaceContext";
import { dashboardCandidateAuthority, dashboardCandidateFilename, downloadFailureGuidance, initialDashboardOfflinePackageState, mapDashboardCandidateError,
  reduceDashboardOfflinePackage, summarizeCandidateObjects, type DashboardCandidateDownloadFormat,
  type DashboardCandidateObjectReport, type DashboardOfflinePackageEvent, type DashboardPublicationPointer } from "./dashboardOfflinePackageState";
import type { DashboardCandidateAndroidSigning } from "../apiClients/dashboardPublicationApi";
import "./DashboardOfflinePackageDialog.css";

/** 作者端离线运行包入口:发布后的应用可在此准备候选并下载单 EXE/ZIP/DMDA。 */
export function DashboardOfflinePackageEntry() {
  const { application, busy, locale } = useDashboardWorkspace();
  const [open, setOpen] = useState(false);
  return <>
    <button disabled={busy} aria-haspopup="dialog"
      title={tr(locale, "准备离线运行包并下载", "Prepare the offline runtime package for download")}
      onClick={() => setOpen(true)}>
      <Package size={15} />
      {tr(locale, "离线包", "Offline")}
    </button>
    {open && createPortal(<DashboardOfflinePackageDialog
      key={`${application.metadata.projectId}:${application.metadata.id}`}
      locale={locale}
      projectId={application.metadata.projectId}
      applicationId={application.metadata.id}
      onClose={() => setOpen(false)} />, document.body)}
  </>;
}

function DashboardOfflinePackageDialog({ locale, projectId, applicationId, onClose }: {
  locale: AppLocale; projectId: string; applicationId: string; onClose(): void;
}) {
  const escape = useDialogEscape(onClose);
  const [state, dispatch] = useReducer(reduceDashboardOfflinePackage, undefined, initialDashboardOfflinePackageState);
  const [downloadBusy, setDownloadBusy] = useState<DashboardCandidateDownloadFormat | undefined>();
  // Android 请求级签名;keystore 留空时服务端用部署默认签名,不强制作者上传。
  const [signing, setSigning] = useState<{ keystore?: File; storePassword: string; keyAlias: string; keyPassword: string }>(
    { storePassword: "", keyAlias: "", keyPassword: "" });
  const ticket = useRef(0), controller = useRef<AbortController | undefined>(undefined), focused = useRef<HTMLElement>(null);

  const run = useCallback((event: DashboardOfflinePackageEvent) => dispatch(event), []);
  // 迟到响应防护:每次新操作推进 ticket;旧序号的 settle 与关闭后的回调一律丢弃。
  const abortInFlight = useCallback(() => {
    ticket.current += 1;
    controller.current?.abort();
    controller.current = undefined;
  }, []);

  const prepare = useCallback((pointer: DashboardPublicationPointer) => {
    const authority = dashboardCandidateAuthority(pointer);
    if (!authority) return;
    abortInFlight();
    const sequence = ++ticket.current;
    const active = new AbortController();
    controller.current = active;
    run({ type: "prepare" });
    api.prepareDashboardCandidate(projectId, applicationId,
      authority, active.signal)
      .then(candidate => { if (sequence === ticket.current) run({ type: "prepared", candidate }); })
      .catch(reason => {
        if (active.signal.aborted || sequence !== ticket.current) return;
        run({ type: "failed", error: mapDashboardCandidateError(reason) });
      });
  }, [abortInFlight, applicationId, projectId, run]);

  // 打开时读取当前发布版本;没有发布版本时给可操作指引而不是报错。
  useEffect(() => {
    let cancelled = false;
    api.readActivePublication(applicationId)
      .then(pointer => { if (!cancelled) run({ type: "publication", pointer }); })
      .catch(() => { if (!cancelled) run({ type: "publication", pointer: undefined }); });
    return () => { cancelled = true; };
  }, [applicationId, run]);

  // 关闭/卸载(含 Escape)即中止在途请求,迟到的 prepared/failed 不会进入已卸载的视图。
  useEffect(() => () => abortInFlight(), [abortInFlight]);
  useEffect(() => {
    const previous = document.activeElement;
    focused.current?.focus();
    return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, []);

  const download = useCallback(async (format: DashboardCandidateDownloadFormat, candidateId: string) => {
    if (downloadBusy) return;
    const sequence = ++ticket.current;
    const active = new AbortController();
    controller.current = active;
    setDownloadBusy(format);
    let signingRequest: DashboardCandidateAndroidSigning | undefined;
    if (format === "apk" && signing.keystore && signing.storePassword && signing.keyAlias) {
      const bytes = new Uint8Array(await signing.keystore.arrayBuffer());
      let binary = "";
      for (const byte of bytes) binary += String.fromCharCode(byte);
      signingRequest = {
        keystoreBase64: btoa(binary),
        storePassword: signing.storePassword,
        keyAlias: signing.keyAlias,
        ...(signing.keyPassword ? { keyPassword: signing.keyPassword } : {}),
      };
    }
    api.openDashboardCandidateDownload(projectId, applicationId, candidateId, format, active.signal, undefined, signingRequest)
      .then(async response => {
        if (sequence !== ticket.current) return;
        if (!response.ok) {
          let code: string | undefined, message = "";
          try {
            const body = await response.json() as { code?: string; message?: string };
            code = body.code; message = body.message ?? "";
          } catch { /* 非 JSON 错误体时走通用失败提示 */ }
          if (active.signal.aborted || sequence !== ticket.current) return;
          run({ type: "failed", error: mapDashboardCandidateError({ status: response.status, body: { code, message } }) });
          return;
        }
        const blob = await response.blob();
        if (sequence !== ticket.current) return;
        const filename = dashboardCandidateFilename(response.headers.get("content-disposition"), candidateId, format);
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        anchor.href = url; anchor.download = filename;
        document.body.append(anchor); anchor.click(); anchor.remove();
        setTimeout(() => URL.revokeObjectURL(url), 10_000);
      })
      .catch(reason => {
        if (active.signal.aborted || sequence !== ticket.current) return;
        run({ type: "failed", error: mapDashboardCandidateError(reason) });
      })
      .finally(() => { if (sequence === ticket.current) setDownloadBusy(undefined); });
  }, [applicationId, downloadBusy, projectId, run, signing]);

  const pointer = state.phase === "idle" || state.phase === "preparing" || state.phase === "ready" || state.phase === "failed"
    ? state.pointer : undefined;
  const androidSigningComplete = Boolean(signing.keystore && signing.storePassword && signing.keyAlias);
  return <div ref={escape} className="dialog-backdrop dashboard-offline-dialog">
    <section ref={focused} tabIndex={-1} role="dialog" aria-modal="false" aria-label={tr(locale, "离线运行包", "Offline runtime package")}>
      <header className="dashboard-offline-heading">
        <strong>{tr(locale, "离线运行包", "Offline runtime package")}</strong>
        <button type="button" aria-label={tr(locale, "关闭离线包", "Close offline package dialog")} onClick={onClose}><X size={16} /></button>
      </header>
      <div className="dashboard-offline-body">
        {pointer && <p className="dashboard-offline-meta">
          #{pointer.applicationRevision} · {new Date(pointer.publishedAt).toLocaleString(locale)}
        </p>}
        {state.phase === "loading" && <p className="dashboard-offline-hint">{tr(locale, "正在读取发布版本…", "Reading the published version…")}</p>}
        {state.phase === "unpublished" && <p className="dashboard-offline-hint">
          {tr(locale, "应用尚未发布。请先在顶部“发布”，再回到这里准备离线包。", "Not published yet. Publish from the toolbar first, then come back for the package.")}
        </p>}
        {pointer && !dashboardCandidateAuthority(pointer) && <p className="dashboard-offline-error" role="alert">
          {tr(locale, "发布版本缺少有效入口页。请修正并重新发布。", "The published version has no valid entry page. Correct it and publish again.")}
        </p>}
        {state.phase === "failed" && <p className="dashboard-offline-error" role="alert">
          {state.error.code === "candidate_rejected" && state.error.status === 0
            ? tr(locale, "网络中断或服务不可用，请稍后重试", "Network interrupted or service unavailable; retry later")
            : downloadFailureGuidance(state.error)}
        </p>}
        {state.phase === "preparing" && <p className="dashboard-offline-hint dashboard-offline-busy">
          <LoaderCircle className="spin" size={15} />
          <span>{tr(locale, "正在冻结数据/字体并编译运行包…", "Freezing data/fonts and compiling the runtime package…")}</span>
          <button type="button" onClick={() => { abortInFlight(); run({ type: "cancelled" }); }}>
            {tr(locale, "取消", "Cancel")}
          </button>
        </p>}
        {state.phase === "ready" && <>
          <ObjectSummary locale={locale} objects={state.candidate.objects} />
          <p className="dashboard-offline-meta">
            {tr(locale, "有效期至", "Valid until")} {new Date(state.candidate.expiresAt).toLocaleTimeString(locale)}
          </p>
          <div className="dashboard-offline-downloads">
            {state.candidate.downloadFormats.includes("exe") && <button type="button" className="primary"
              disabled={Boolean(downloadBusy)} onClick={() => download("exe", state.candidate.candidateId)}>
              {downloadBusy === "exe" ? tr(locale, "下载中…", "Downloading…") : tr(locale, "下载单文件 EXE", "Download single EXE")}
            </button>}
            {state.candidate.downloadFormats.includes("zip") && <button type="button" disabled={Boolean(downloadBusy)}
              onClick={() => download("zip", state.candidate.candidateId)}>ZIP</button>}
            {state.candidate.downloadFormats.includes("web") && <button type="button" disabled={Boolean(downloadBusy)}
              onClick={() => download("web", state.candidate.candidateId)}>{tr(locale, "网页包", "Web package")}</button>}
            {state.candidate.downloadFormats.includes("dmda") && <button type="button" disabled={Boolean(downloadBusy)}
              onClick={() => download("dmda", state.candidate.candidateId)}>DMDA</button>}
            {state.candidate.downloadFormats.includes("apk") && <button type="button"
              disabled={Boolean(downloadBusy) || state.candidate.androidSigningMode === "client-required" && !androidSigningComplete}
              title={state.candidate.androidSigningMode === "client-required" && !androidSigningComplete
                ? tr(locale, "请先展开下方签名设置，上传 keystore 并填写口令与别名", "Upload a keystore and enter its password and alias below")
                : tr(locale, "打包场景安卓查看器 APK；视频媒体在 Android 首片降级", "Package the Android scene viewer APK; video media is degraded on the first Android slice")}
              onClick={() => download("apk", state.candidate.candidateId)}>
              {downloadBusy === "apk" ? tr(locale, "打包中…", "Packaging…") : tr(locale, "安卓 APK", "Android APK")}
            </button>}
          </div>
          {state.candidate.downloadFormats.includes("apk") && <details className="dashboard-offline-signing"
            open={state.candidate.androidSigningMode === "client-required"}>
            <summary>{state.candidate.androidSigningMode === "client-required"
              ? tr(locale, "Android 签名（此部署必须填写）", "Android signing (required by this deployment)")
              : tr(locale, "Android 签名（可选，留空使用服务器默认签名）", "Android signing (optional; server default when empty)")}</summary>
            <label className="dashboard-offline-signing-row">
              <span>keystore</span>
              <input type="file" accept=".keystore,.jks,.p12,application/octet-stream"
                onChange={event => setSigning(previous => ({
                  ...previous,
                  ...(event.target.files?.[0] ? { keystore: event.target.files[0] } : {}),
                }))} />
            </label>
            <label className="dashboard-offline-signing-row">
              <span>{tr(locale, "keystore 口令", "Keystore password")}</span>
              <input type="password" autoComplete="off" value={signing.storePassword}
                onChange={event => setSigning(previous => ({ ...previous, storePassword: event.target.value }))} />
            </label>
            <label className="dashboard-offline-signing-row">
              <span>{tr(locale, "别名", "Alias")}</span>
              <input type="text" value={signing.keyAlias}
                onChange={event => setSigning(previous => ({ ...previous, keyAlias: event.target.value }))} />
            </label>
            <label className="dashboard-offline-signing-row">
              <span>{tr(locale, "key 口令（可选）", "Key password (optional)")}</span>
              <input type="password" autoComplete="off" value={signing.keyPassword}
                onChange={event => setSigning(previous => ({ ...previous, keyPassword: event.target.value }))} />
            </label>
          </details>}
        </>}
        <div className="dashboard-offline-footer">
          {(state.phase === "ready" || state.phase === "failed") && pointer && dashboardCandidateAuthority(pointer) &&
            <button type="button" onClick={() => prepare(pointer)}
              title={tr(locale, "作废当前候选并重新冻结编译", "Discard the current candidate and re-freeze")}>
              {tr(locale, "重新准备", "Prepare again")}
            </button>}
          {state.phase === "idle" && pointer && dashboardCandidateAuthority(pointer) &&
            <button type="button" className="primary" onClick={() => prepare(pointer)}>
              {tr(locale, "开始准备", "Prepare")}
            </button>}
        </div>
      </div>
    </section>
  </div>;
}

function ObjectSummary({ locale, objects }: {
  locale: AppLocale; objects: readonly DashboardCandidateObjectReport[];
}) {
  const summary = summarizeCandidateObjects(objects);
  const notable = objects.filter(object => object.status !== "supported");
  return <div className="dashboard-offline-objects">
    <p>
      {tr(locale, `共 ${summary.total} 个对象：${summary.blocked} 阻断 / ${summary.degraded} 降级`,
        `${summary.total} objects: ${summary.blocked} blocked / ${summary.degraded} degraded`)}
    </p>
    {notable.length > 0 && <ul>
      {notable.map(object => {
        const reasons = object.reasons ?? [];
        return <li key={object.nodeId}>
          <span className={`dashboard-offline-status is-${object.status}`}>{object.status}</span>
          <code>{object.nodeId}</code>
          {(reasons.length > 0 || object.deferredFields.length > 0) && <span className="dashboard-offline-deferred">
            <span className="dashboard-offline-reason-label">
              {object.status === "blocked"
                ? tr(locale, "阻断原因", "Blocked because")
                : tr(locale, "降级原因", "Degraded because")}
              {reasons.length > 0
                ? tr(locale, "：", ": ")
                : tr(locale, `：${object.deferredFields.length} 项字段未编译`, `: ${object.deferredFields.length} fields were not compiled`)}
            </span>
            {reasons.length > 0 && <span className="dashboard-offline-deferred-fields" title={reasons.join("; ")}>
              {reasons.join("；")}
            </span>}
            <span className="dashboard-offline-deferred-fields" title={object.deferredFields.join(", ")}>
              {object.deferredFields.join("、")}
            </span>
          </span>}
        </li>;
      })}
    </ul>}
  </div>;
}
