import { AlertTriangle, ArrowRight, Route } from "lucide-react";
import { useMemo } from "react";
import type { PprBopVersionDraft } from "@bim-studio/contracts";
import {
  preparePlantLiteDraftFromPpr,
  type PprPlantLiteReadyDraft,
} from "./pprPlantLiteDraft";

export function PprPlantLiteHandoff({
  draft,
  busy,
  onCreateDraft,
}: {
  draft: PprBopVersionDraft;
  busy: boolean;
  onCreateDraft: (result: PprPlantLiteReadyDraft) => void;
}) {
  const preparation = useMemo(() => preparePlantLiteDraftFromPpr(draft), [draft]);
  return (
    <section className="ppr-plant-handoff" aria-label="转为流程仿真草稿">
      <header>
        <span><Route size={15} /><strong>继续做流程仿真</strong></span>
        <em>可编辑草稿</em>
      </header>
      {preparation.status === "blocked" ? (
        <div className="ppr-plant-handoff-blocked">
          {preparation.blockers.slice(0, 3).map((blocker, index) => (
            <p key={`${blocker.code}-${blocker.sourceId ?? index}`}><AlertTriangle size={13} /><span>{blocker.message}</span></p>
          ))}
          <button type="button" disabled title={preparation.blockers[0]?.message}>生成仿真草稿</button>
        </div>
      ) : (
        <>
          <div className="ppr-plant-handoff-summary">
            <span><small>来料间隔</small><strong>{formatNumber(preparation.report.arrivalIntervalMinutes)} 分钟</strong></span>
            <span><small>最低吞吐</small><strong>{formatNumber(preparation.report.minimumThroughputPerHour)} 件/时</strong></span>
            <span><small>已转换</small><strong>{preparation.report.mappedOperations.length} 工序 · {preparation.report.mappedResources.length} 设备</strong></span>
          </div>
          {preparation.report.reviewItems.length > 0 && (
            <details className="ppr-plant-handoff-review">
              <summary><AlertTriangle size={12} />{preparation.report.reviewItems.length} 项需在仿真草稿中复核</summary>
              <div>{preparation.report.reviewItems.map((item, index) => <p key={`${item.code}-${index}`}>{item.message}</p>)}</div>
            </details>
          )}
          <p className="ppr-plant-handoff-scope">只转换确定性工时和可表达的设备/机器人；{preparation.report.retainedInProcessPlan.join("、")}仍保留在工艺计划中。</p>
          <footer>
            <small>切换到流程仿真后可继续调整；不会自动运行。</small>
            <button className="primary" type="button" disabled={busy} onClick={() => onCreateDraft(preparation)}>生成仿真草稿<ArrowRight size={13} /></button>
          </footer>
        </>
      )}
    </section>
  );
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}
