import type { DataDatasetRecord, DataPipelineDefinition } from "@bim-studio/contracts";
import { Clock3, Database } from "lucide-react";
import { translate as tr, type AppLocale } from "../i18n";
import { resolveDataProductRefreshSeconds } from "./dataRefreshPolicy";

export function DashboardDataRefreshSummary({
  locale,
  kind,
  productId,
  datasets,
  pipelines,
  onOpenData,
}: {
  readonly locale: AppLocale;
  readonly kind: "dataset" | "pipeline";
  readonly productId: string;
  readonly datasets: readonly DataDatasetRecord[];
  readonly pipelines: readonly DataPipelineDefinition[];
  readonly onOpenData: () => void;
}) {
  const seconds = resolveDataProductRefreshSeconds(kind, productId, datasets, pipelines);
  const manual = seconds === 0;
  return (
    <div className="dashboard-data-refresh-summary" aria-label={tr(locale, "更新策略", "Update policy")}>
      <Clock3 aria-hidden="true" size={13} />
      <span>
        <small>{tr(locale, "更新策略", "Update policy")}</small>
        <strong>{manual ? tr(locale, "手动更新", "Manual") : tr(locale, `定时更新 · 每 ${seconds} 秒`, `Scheduled · every ${seconds}s`)}</strong>
      </span>
      <button type="button" title={tr(locale, "前往数据中心设置更新策略", "Configure the update policy in Data Center")} onClick={onOpenData}>
        <Database aria-hidden="true" size={12} />
        {tr(locale, "数据中心", "Data Center")}
      </button>
      <small className="dashboard-data-refresh-origin">
        {kind === "pipeline" ? tr(locale, "继承自源数据集", "Inherited from source datasets") : tr(locale, "继承自数据集", "Inherited from dataset")}
      </small>
    </div>
  );
}
