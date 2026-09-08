import { createContext, useContext } from "react";
import type { DashboardDataWidgetConfig, DataDatasetRecord } from "@bim-studio/contracts";
import { translate as tr, type AppLocale } from "../i18n";
import { dashboardWritebackDataset } from "./DashboardDatasetWriteback";
import { DatasetWritebackPanel } from "./DatasetWritebackPanel";
import type { WritebackRefresh } from "./useWritebackRefreshFeedback";
import "./DashboardRecordForm.css";

export interface DashboardRecordFormAccess {
  userId: string;
  canWrite: boolean;
  datasets: readonly DataDatasetRecord[];
  onSaved(datasetId: string): ReturnType<WritebackRefresh>;
}

/** 运行权限由宿主显式提供，发布文档和脚本变量不能提升权限。 */
export const DashboardRecordFormContext = createContext<DashboardRecordFormAccess | undefined>(undefined);

export function DashboardRecordForm({ widget, projectId, locale, runtime }: {
  widget: DashboardDataWidgetConfig; projectId: string; locale: AppLocale; runtime: boolean;
}) {
  const access = useContext(DashboardRecordFormContext);
  const recordId = widget.recordForm?.recordId ?? "";
  const dataset = access ? dashboardWritebackDataset(projectId, widget, access.datasets) : undefined;
  const message = !runtime ? tr(locale, "在数据属性中配置记录", "Configure the record in Data properties")
    : !access?.userId ? tr(locale, "公开页只读，填报需在登录后的作者预览中操作。", "Public pages are read-only. Use authenticated author preview for record entry.")
    : !dataset ? tr(locale, "请选择已启用填报的数据集", "Select a dataset with record entry enabled")
    : !/^[\p{L}\p{N}_-]{1,128}$/u.test(recordId) ? tr(locale, "请配置有效的记录编号", "Configure a valid record ID") : undefined;
  return <div className="dashboard-record-form" onClick={event => { if (runtime) event.stopPropagation(); }} onDoubleClick={event => { if (runtime) event.stopPropagation(); }}>
    {message ? <div className="dashboard-record-form-placeholder" role="note">
      <strong>{widget.title || tr(locale, "填报表单", "Record form")}</strong>
      {!runtime && recordId && <span>{recordId}</span>}
      <span>{message}</span>
    </div> : dataset && access && <DatasetWritebackPanel key={`${access.userId}:${projectId}:${dataset.id}:${recordId}`} locale={locale}
      projectId={projectId} dataset={dataset} userId={access.userId} canWrite={access.canWrite}
      fixedRecordId={recordId} onSaved={() => access.onSaved(dataset.id)} />}
  </div>;
}
