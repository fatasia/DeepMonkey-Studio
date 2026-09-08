import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import type { DashboardDataWidgetConfig, DataDatasetRecord, DataWritebackConfig } from "@bim-studio/contracts";
import { translate as tr, type AppLocale } from "../i18n";
import { useDialogEscape } from "../hooks/useGlobalDialogEscape";
import { DatasetWritebackPanel } from "./DatasetWritebackPanel";
import type { WritebackRefresh } from "./useWritebackRefreshFeedback";
import "./DashboardDatasetWriteback.css";

type WritableDataset = DataDatasetRecord & { writeback: DataWritebackConfig };
type Binding = Pick<DashboardDataWidgetConfig, "datasetId" | "pipelineId" | "sampleData" | "directBinding">;

/** 写回目标只来自当前项目已保存的数据集，示例/直连/管道不能借用残留 datasetId。 */
export function dashboardWritebackDataset(projectId: string, widget: Binding, datasets: readonly DataDatasetRecord[]): WritableDataset | undefined {
  if (!widget.datasetId || widget.pipelineId || widget.sampleData || widget.directBinding) return undefined;
  const dataset = datasets.find(item => item.id === widget.datasetId && item.projectId === projectId);
  return dataset?.writeback ? dataset as WritableDataset : undefined;
}

export function DashboardDatasetWriteback({ locale, projectId, widget, datasets, userId, canWrite, onSaved, onOpen, fieldsOpen }: {
  locale: AppLocale; projectId: string; widget: Binding; datasets: readonly DataDatasetRecord[]; userId: string; canWrite: boolean;
  onSaved?(datasetId: string): ReturnType<WritebackRefresh>; onOpen?(): void; fieldsOpen?: boolean;
}) {
  const [open, setOpen] = useState(false);
  useEffect(() => { if (fieldsOpen) setOpen(false); }, [fieldsOpen]);
  const dataset = dashboardWritebackDataset(projectId, widget, datasets);
  if (!dataset || !userId) return null;
  return <div className="dashboard-writeback-entry">
    <button type="button" aria-expanded={open} onClick={() => { onOpen?.(); setOpen(true); }} title={!canWrite ? tr(locale, "当前账号只读", "This account is read-only") : dataset.name}>
      {tr(locale, "填报", "Record entry")}
    </button>
    {open && createPortal(<WritebackDock key={`${userId}:${projectId}:${dataset.id}`} locale={locale} projectId={projectId} dataset={dataset}
      userId={userId} canWrite={canWrite} onSaved={() => onSaved?.(dataset.id)} onClose={() => setOpen(false)} />, document.body)}
  </div>;
}

function WritebackDock({ locale, projectId, dataset, userId, canWrite, onSaved, onClose }: {
  locale: AppLocale; projectId: string; dataset: WritableDataset; userId: string; canWrite: boolean; onClose(): void; onSaved: WritebackRefresh;
}) {
  const escape = useDialogEscape(onClose);
  const focus = useRef<HTMLElement>(null);
  useEffect(() => {
    const previous = document.activeElement;
    focus.current?.focus();
    return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, []);
  return <div ref={escape} className="dialog-backdrop dashboard-writeback-dock">
    <section ref={focus} tabIndex={-1} role="dialog" aria-modal="false" aria-label={tr(locale, "数据集填报", "Dataset record entry")}>
      <header className="dashboard-writeback-dock-heading">
        <strong title={dataset.name}>{dataset.name}</strong>
        <button type="button" aria-label={tr(locale, "关闭填报", "Close record entry")} onClick={onClose}><X size={16} /></button>
      </header>
      <div className="dashboard-writeback-dock-body">
        <DatasetWritebackPanel locale={locale} projectId={projectId} dataset={dataset} userId={userId} canWrite={canWrite} onSaved={onSaved} />
      </div>
    </section>
  </div>;
}
