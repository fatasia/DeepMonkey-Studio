import type { PlantLiteStudyRecord } from "@bim-studio/contracts";

export function PlantLiteEquipmentEvidence({ result }: { result: PlantLiteStudyRecord }) {
  const equipment = result.model?.resources?.filter((resource) => resource.kind === "equipment") ?? [];
  if (!equipment.length) return null;
  return <section className="plant-equipment-evidence" aria-label="设备可靠性证据">
    <header><span>设备可靠性</span><small>计划利用率与故障产能损失均来自本次 DES 重复运行</small></header>
    {equipment.map((resource) => {
      const utilization = result.outcome.resourceUtilization95[resource.id];
      const downtime = result.outcome.resourceFailedMinutes95?.[resource.id];
      return <div key={resource.id} role="group" aria-label={resource.name}>
        <span>{resource.name}</span>
        <strong>{utilization ? `${percent(utilization.mean)} 计划利用率` : "利用率无证据"}</strong>
        <small>{utilization ? `计划利用率 95% CI ${percent(utilization.lower95)}–${percent(utilization.upper95)}` : "本次结果缺少资源利用率"}</small>
        <small>{downtime ? `故障损失 ${minutes(downtime.mean)} 台·分 · 95% CI ${minutes(downtime.lower95)}–${minutes(downtime.upper95)}` : "旧记录没有故障损失区间"}</small>
      </div>;
    })}
  </section>;
}

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function minutes(value: number): string {
  return value.toFixed(1);
}
