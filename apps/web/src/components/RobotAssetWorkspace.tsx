import { useEffect, useRef, useState } from "react";
import type { ModelRecord, ProjectRecord } from "@bim-studio/contracts";
import type { ViewerEngine } from "../viewer/ViewerEngine";
import { translate as tr, type AppLocale } from "../i18n";
import { api } from "../api";
import { compressRobotPackage } from "../robots/robotPackageCompression";
import { waitForOptimizerModel } from "../optimizer/modelOptimizerAssets";
import { downloadBlob } from "../browserDownload";
import { ModelImportInput } from "./ModelImportInput";
import { RobotAssetPreview } from "./RobotAssetPreview";
import { RobotJointPreview } from "./RobotJointPreview";
import { dispatchRobotPoseCommand } from "../commands/engineCommandApplier";
import { robotPoseCommand } from "../commands/engineEditCommand";
import { RobotAssetMediaActions } from "./RobotAssetMediaActions";
import { SecondaryPageBack } from "./SecondaryPageBack";
import "./RobotAssetWorkspace.css";

export function RobotAssetWorkspace({ locale, model, project, onBack, onImport, importBusy, importError, onCancelImport, onProjectChange, onViewAssets, onReturnToScene, returnMode = "insert" }: {
  locale: AppLocale; model: ModelRecord; project: ProjectRecord; onBack: () => void;
  onImport: (file?: File, entry?: string) => Promise<void>;
  importBusy?: boolean; importError?: string | undefined; onCancelImport(): void;
  onProjectChange?: ((project: ProjectRecord) => void) | undefined;
  onViewAssets?: ((id?: string) => void) | undefined; onReturnToScene?: ((id?: string) => void) | undefined; returnMode?: "insert" | "replace";
}) {
  const t = (zh: string, en: string) => tr(locale, zh, en);
  const input = useRef<HTMLInputElement>(null);
  const [engine, setEngine] = useState<ViewerEngine>();
  const [, revise] = useState(0);
  const [processing, setBusy] = useState(false);
  const busy = processing || Boolean(importBusy);
  const [error, setError] = useState("");
  const [result, setResult] = useState<File>();
  const [savedId, setSavedId] = useState<string>();
  const operation = useRef<AbortController | undefined>(undefined);
  const receipt = useRef<Promise<ModelRecord> | undefined>(undefined);
  useEffect(() => () => operation.current?.abort(), [model.id]);
  const cancel = () => { operation.current?.abort(); operation.current = undefined; setBusy(false); };
  async function perform(action: (signal: AbortSignal) => Promise<void>) {
    if (operation.current) return;
    const controller = new AbortController(); operation.current = controller; setBusy(true); setError("");
    try { await action(controller.signal); }
    catch (reason) { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { if (operation.current === controller) { operation.current = undefined; if (!controller.signal.aborted) setBusy(false); } }
  }
  const save = () => perform(async signal => {
    if (!result) return;
    const upload = receipt.current ??= api.uploadOptimizedModel(project.id, result, model.id);
    let uploaded: ModelRecord;
    try { uploaded = await upload; } catch (reason) { if (receipt.current === upload) receipt.current = undefined; throw reason; }
    signal.throwIfAborted();
    const updated = await waitForOptimizerModel(project.id, uploaded.id, undefined, signal);
    signal.throwIfAborted(); onProjectChange?.(updated); setSavedId(uploaded.id);
  });
  return <section className="robot-asset-workspace">
    <header><SecondaryPageBack locale={locale} onBack={onBack} /><h1 title={model.name}>{model.name}</h1>
      <button className="button" disabled={busy} onClick={() => input.current?.click()}>{t("导入", "Import")}</button>
      {onViewAssets && <button className="button" onClick={() => onViewAssets(savedId ?? model.id)}>{t("素材库", "Asset library")}</button>}
    </header>
    <div className="robot-asset-body"><RobotAssetPreview locale={locale} model={model} onReady={setEngine} />
      <aside>
        <RobotAssetMediaActions locale={locale} model={model} engine={engine} disabled={busy} />
        {engine && <RobotJointPreview locale={locale} engine={engine} modelId={model.id} disabled={busy} onChange={() => revise(value => value + 1)}
          onPoseCommand={values => dispatchRobotPoseCommand(engine, robotPoseCommand(locale, model.id, values))} />}
        <section className="robot-package-actions" aria-label={t("模型压缩", "Model compression")}>
          <h2>{t("无损压缩", "Lossless compression")}</h2>
          <span>{(model.size / 1024).toFixed(1)} KB{result ? ` → ${(result.size / 1024).toFixed(1)} KB` : ""}</span>
          <button className="button" disabled={busy} title={t("保留原始文件与关节结构，只压缩机器人包", "Preserve files and joints; compress the package only")} onClick={() => void perform(async signal => {
            const file = await compressRobotPackage(model, signal); signal.throwIfAborted(); setResult(file); setSavedId(undefined); receipt.current = undefined;
          })}>{t("压缩", "Compress")}</button>
          {result && <button className="button" disabled={busy} onClick={() => downloadBlob(result, result.name)}>{t("下载", "Download")}</button>}
          {result && !savedId && <button className="button primary" disabled={busy} onClick={() => void save()}>{t("另存素材", "Save as asset")}</button>}
          {savedId && <span role="status">{t("已保存", "Saved")}</span>}
          {busy && <span role="status">{t("正在处理…", "Processing…")}</span>}
          {processing && <button className="button" title={t("停止本地处理或等待；已提交的素材保留，重试继续同一任务", "Stop processing or waiting; submitted assets stay and retries reuse the task")} onClick={cancel}>{t("取消处理", "Cancel processing")}</button>}
          {error && <span role="alert">{error}</span>}
        </section>
        {onReturnToScene && <button className={`button${result && !savedId ? "" : " primary"}`} disabled={busy} onClick={() => onReturnToScene(savedId ?? model.id)}>{returnMode === "replace" ? t("应用并返回场景", "Apply and return") : t("添加到场景", "Add to scene")}</button>}
        {importBusy && <button className="button" onClick={onCancelImport}>{t("取消导入", "Cancel import")}</button>}
        {importError && <p role="alert">{importError}</p>}
      </aside>
    </div>
    <ModelImportInput inputRef={input} locale={locale} scopeKey={project.id} onFiles={async (files, entries) => { const file = files[0]; if (file) await onImport(file, entries.get(file)); }} />
  </section>;
}
