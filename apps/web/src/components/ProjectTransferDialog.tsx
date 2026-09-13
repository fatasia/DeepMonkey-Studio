import { useEffect, useRef, useState } from "react";
import { Download, FileUp, LoaderCircle, X } from "lucide-react";
import type { ProjectRecord } from "@bim-studio/contracts";
import { downloadBlob } from "../browserDownload";
import { exportProjectTransfer, readProjectTransfer, type ProjectTransferArchive } from "../delivery/projectTransferArchive";
import { ProjectTransferImport } from "../delivery/projectTransferImport";
import { safeTransferName } from "../delivery/projectTransferModel";
import { loadViewerAssetBuffer } from "../viewer/viewerAssetTransport";
import { translate as tr, type AppLocale } from "../i18n";
import "./ProjectResourceDialogs.css";
import "./ProjectTransferDialog.css";

export function ProjectTransferDialog({ project, locale, onClose, onImported }: {
  project?: ProjectRecord | undefined; locale: AppLocale; onClose: () => void; onImported: (project: ProjectRecord) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const operation = useRef<AbortController | undefined>(undefined);
  const importer = useRef<ProjectTransferImport | undefined>(undefined);
  const [archive, setArchive] = useState<ProjectTransferArchive>();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState("");
  const [error, setError] = useState("");
  const [complete, setComplete] = useState<ProjectRecord>();
  const t = (zh: string, en: string) => tr(locale, zh, en);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const element = dialog.current; element?.showModal();
    return () => { operation.current?.abort(); element?.close(); previous?.focus(); };
  }, []);

  async function run(action: (signal: AbortSignal) => Promise<void>) {
    if (operation.current) return;
    const controller = new AbortController(); operation.current = controller;
    setBusy(true); setError(""); setProgress("");
    try { await action(controller.signal); }
    catch (reason) { setError(controller.signal.aborted ? t("已停止，可重试继续", "Stopped. Retry to continue") : reason instanceof Error ? reason.message : String(reason)); }
    finally { operation.current = undefined; setBusy(false); }
  }
  function replaceFile(id: string, file: File) {
    importer.current?.replaceFile(id, file);
    if (archive) { archive.files.set(id, file); setArchive({ ...archive }); }
    setError("");
  }
  const missing = archive?.document.files.filter(file => !archive.files.has(file.id)) ?? [];
  const sourceResources = [
    ...(project?.models ?? []).filter(model => model.status === "ready" && model.manifest?.geometryUrl).map(model => ({ id: model.id, name: model.name, url: model.manifest!.geometryUrl! })),
    ...(project?.assets ?? []).map(asset => ({ id: asset.id, name: asset.name, url: asset.url })),
  ];
  const pendingConnections = archive?.document.runtime.connections.filter(connection => connection.type !== "simulation").length ?? 0;
  return <dialog ref={dialog} className="project-resource-dialog project-transfer-dialog" aria-label={t("项目交付", "Project delivery")}
    onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}>
    <header><h2>{t("项目交付", "Project delivery")}</h2><button type="button" disabled={busy} aria-label={t("关闭", "Close")} onClick={onClose}><X size={18} /></button></header>
    <div className="project-transfer-actions">
      <button className="button" disabled={busy || !project} onClick={() => void run(async signal => {
        const blob = await exportProjectTransfer(project!.id, signal, setProgress); signal.throwIfAborted();
        downloadBlob(blob, `${safeTransferName(project!.name)}.bimproject`); setProgress(t("项目包已下载", "Project package downloaded"));
      })}><Download size={15} />{t("导出当前项目", "Export current project")}</button>
      <label className="button"><FileUp size={15} />{t("选择项目包", "Choose project package")}
        <input type="file" accept=".bimproject" disabled={busy} aria-label={t("选择项目包", "Choose project package")} onChange={event => {
          const file = event.target.files?.[0]; event.target.value = "";
          if (file) void run(async () => {
            const next = await readProjectTransfer(file); importer.current = new ProjectTransferImport(next);
            setArchive(next); setName(`${next.document.project.name} - ${t("导入", "Imported")}`); setComplete(undefined);
          });
        }} />
      </label>
    </div>
    {archive && <div className="project-transfer-review">
      <label>{t("新项目名称", "New project name")}<input value={name} disabled={busy || Boolean(complete)} onChange={event => setName(event.target.value)} /></label>
      <p>{t(`${archive.document.scenes.length} 个场景 · ${archive.document.applications.length} 个应用 · ${archive.document.files.length} 个文件 · ${archive.document.versions.length} 项版本清单`,
        `${archive.document.scenes.length} scenes · ${archive.document.applications.length} applications · ${archive.document.files.length} files · ${archive.document.versions.length} version entries`)}</p>
      {pendingConnections > 0 && <p>{t(`${pendingConnections} 个数据连接需在新项目中重新配置；凭据不随项目包传递。`, `${pendingConnections} data connections need configuration in the new project. Credentials are excluded.`)}</p>}
      <div className="project-transfer-files" aria-label={t("资源映射", "Resource mapping")}>
        {archive.document.files.map(file => <div key={file.id} className={!archive.files.has(file.id) ? "missing" : ""}>
          <span title={file.name}><strong>{file.name}</strong><small>{archive.files.has(file.id) ? archive.files.get(file.id)!.name : t("待补齐", "Missing")}</small></span>
          <label className="button">{t("替代文件", "Replacement file")}<input type="file" disabled={busy || Boolean(complete)} aria-label={`${file.name} ${t("替代文件", "replacement file")}`}
            onChange={event => { const value = event.target.files?.[0]; event.target.value = ""; if (value) replaceFile(file.id, value); }} /></label>
          {sourceResources.length > 0 && <select value="" disabled={busy || Boolean(complete)} aria-label={`${file.name} ${t("映射到资源", "map to resource")}`}
            onChange={event => { const source = sourceResources.find(item => item.id === event.target.value); if (source) void run(async signal => {
              const content = await loadViewerAssetBuffer(source.url, source.name, { signal, timeoutMs: 120_000 });
              const extension = source.url.split(/[?#]/)[0]?.split(".").pop() ?? "glb";
              replaceFile(file.id, new File([content], `${source.name.replace(/\.[^.]+$/, "")}.${extension}`));
            }); }}><option value="">{t("映射当前项目资源", "Map current project resource")}</option>
            {sourceResources.map(source => <option key={source.id} value={source.id}>{source.name}</option>)}</select>}
        </div>)}
      </div>
    </div>}
    {progress && <p role="status">{busy && <LoaderCircle size={14} className="spin" />}{progress}</p>}
    {error && <p className="project-resource-error" role="alert">{error}</p>}
    <footer><span>{missing.length ? t(`还需补齐 ${missing.length} 个文件`, `${missing.length} files missing`) : t("导入创建独立项目", "Import creates a separate project")}</span>
      {busy ? <button className="button" onClick={() => operation.current?.abort()}>{t("停止", "Stop")}</button>
        : complete ? <button className="button primary" onClick={() => { onImported(complete); onClose(); }}>{t("打开导入项目", "Open imported project")}</button>
        : <button className="button primary" disabled={!archive || !name.trim() || missing.length > 0} onClick={() => void run(async signal => {
          const result = await importer.current!.run(name, signal, setProgress); signal.throwIfAborted(); setComplete(result);
        })}>{error ? t("重试导入", "Retry import") : t("导入到新项目", "Import into new project")}</button>}
    </footer>
  </dialog>;
}
