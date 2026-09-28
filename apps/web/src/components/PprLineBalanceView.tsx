import type { PprBopVersionDraft } from "@bim-studio/contracts";
import type { PprLineBalance } from "@bim-studio/ppr-lite-engine";
import { AlertTriangle, Gauge, Scale } from "lucide-react";
import { proposePprRpw } from "./pprRpwProposal";

export function PprLineBalanceView({ balance, entityName, draft, onChange, busy = false }: {
  balance: PprLineBalance;
  entityName: (id: string) => string;
  draft?: PprBopVersionDraft;
  onChange?: (draft: PprBopVersionDraft) => void;
  busy?: boolean;
}) {
  const proposal = draft ? proposePprRpw(draft) : undefined;
  const target = balance.targetTaktMinutes;
  const efficiency = balance.balanceEfficiency === null ? null : balance.balanceEfficiency * 100;
  return (
    <section className="ppr-line-balance" aria-label="产线平衡分析">
      <header>
        <span><Scale size={13} /><strong>产线平衡</strong></span>
        <small>{target ? `目标节拍 ${format(target)} 分/件` : "设置目标节拍后分析"}</small>
      </header>
      <div className="ppr-balance-summary">
        <span><small>平衡效率</small><strong>{efficiency === null ? "—" : `${format(efficiency)}%`}</strong></span>
        <span><small>理论 / 已配工位</small><strong>{balance.theoreticalMinimumStationUnits ?? "—"} / {format(balance.configuredStationUnits)}</strong></span>
        <span><small>未分配工序</small><strong>{balance.unassignedOperationIds.length}</strong></span>
      </div>
      {balance.stationLoads.length > 0 && <div className="ppr-balance-rows">
        {balance.stationLoads.map((station) => {
          const percent = station.taktUtilization === null ? 0 : station.taktUtilization * 100;
          return <div className={station.status} key={station.resourceId}>
            <span><strong>{entityName(station.resourceId)}</strong><small>{station.operationIds.length} 道工序 · {format(station.stationUnits)} 单元</small></span>
            <i role="progressbar" aria-label={`${entityName(station.resourceId)} 节拍占用`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.min(100, Math.round(percent))}><b style={{ width: `${Math.min(100, percent)}%` }} /></i>
            <em>{format(station.loadPerUnitMinutes)} 分 · {station.taktUtilization === null ? "未判定" : `${format(percent)}%`}</em>
          </div>;
        })}
      </div>}
      <BalanceAdvice balance={balance} entityName={entityName} />
      {draft && <div className="ppr-rpw-proposal">
        <strong>RPW 工位分配建议</strong>
        <small>位置权重启发式，不保证最优；不会修改设备、人员等其他资源分配，也不是产能仿真预测。</small>
        {proposal?.status === "blocked"
          ? <p role="status">{proposal.reason}</p>
          : proposal?.status === "ready" && <>
            <p>{proposal.solution.stationsUsed} 个工位 · {proposal.solution.assignments.length} 道工序 · 建议最大负载 {format(proposal.solution.cycleMinutes)} 分钟</p>
            <ol>{proposal.solution.assignments.map((item) => <li key={item.operationId}>{entityName(item.operationId)} → {entityName(item.stationId)}</li>)}</ol>
            <button type="button" disabled={busy || !onChange} title={!onChange ? "只读分析，不允许覆盖历史版本" : "确认后只更新当前草稿，保存后产生新版本"} onClick={() => {
              if (proposal.status === "ready" && onChange) onChange({ ...draft, resourceAssignments: proposal.assignments });
            }}>应用建议到草稿</button>
          </>}
      </div>}
    </section>
  );
}

function BalanceAdvice({ balance, entityName }: { balance: PprLineBalance; entityName: (id: string) => string }) {
  if (!balance.targetTaktMinutes) return <p><Gauge size={13} />填写目标节拍即可判断工位超载与理论工位数。</p>;
  if (balance.unassignedOperationIds.length) return <p className="warning"><AlertTriangle size={13} />先把 {balance.unassignedOperationIds.map(entityName).join("、")} 分配到工位，结果才完整。</p>;
  if (balance.overloadedResourceIds.length) return <p className="danger"><AlertTriangle size={13} />{balance.overloadedResourceIds.map(entityName).join("、")} 超过目标节拍；可移动工序或增加并行单元。</p>;
  return <p className="healthy"><Gauge size={13} />当前工位负载满足目标节拍，可继续比较资源利用率与版本影响。</p>;
}

function format(value: number): string {
  return Number(value.toFixed(1)).toLocaleString("zh-CN");
}
