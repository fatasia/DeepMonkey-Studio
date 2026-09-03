import type { PlantLiteStudyRecord } from "@bim-studio/contracts";

/** 只展示求解器实际派工占用，不把人员池映射为设备故障、能耗或人体工学结论。 */
export function PlantLiteWorkforceEvidence({ result }: { result: PlantLiteStudyRecord }) {
  const workers = result.model?.resources?.filter((resource) => resource.kind === "worker") ?? [];
  if (!workers.length) return null;
  return <section className="plant-equipment-evidence plant-workforce-evidence" aria-label="人工资源利用率证据">
    <header><span>人工资源</span><small>人数、班次与共享竞争来自已保存模型；利用率来自本次 DES 重复运行</small></header>
    {workers.map((resource) => {
      const utilization = result.outcome.resourceUtilization95[resource.id];
      const stations = result.model?.nodes.filter((node) => node.kind === "station" && node.workerResourceId === resource.id) ?? [];
      return <div key={resource.id} role="group" aria-label={resource.name}>
        <span title={stations.map((station) => station.name).join("、")}>{resource.name}</span>
        <strong>{resource.capacity} 人 · {shiftLabel(resource.availability?.shifts)}</strong>
        <small>{utilization ? `计划利用率 ${percent(utilization.mean)} · 95% CI ${percent(utilization.lower95)}–${percent(utilization.upper95)}` : "本次结果缺少人员利用率证据"}</small>
        <small>{stations.length > 1 ? `${stations.length} 个工位共享：${stations.map((station) => station.name).join("、")}` : stations[0] ? `绑定工位：${stations[0].name}` : "当前没有工位绑定"}</small>
      </div>;
    })}
  </section>;
}

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function shiftLabel(shifts: { startMinute: number; endMinute: number }[] | undefined): string {
  if (!shifts?.length) return "全天可派";
  const minutes = shifts.reduce((sum, shift) => sum + Math.max(0, shift.endMinute - shift.startMinute), 0);
  return `${shifts.length} 班 · ${minutes} 分/日`;
}
