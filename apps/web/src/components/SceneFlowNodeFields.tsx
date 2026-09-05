import type { PlantLiteDistribution } from "@bim-studio/contracts";
import { changeDistributionKind, distributionTypicalValue, setDistributionTypicalValue } from "./plantLiteModelEditing";
import type { SceneFlowNode } from "../simulation/scenePlantModel";

/** 场景角色的快速参数；完整班次/故障/资源池作者器仍在高级运营工作台。 */
export function SceneFlowNodeFields({ entity, onChange }: { entity: SceneFlowNode; onChange: (next: SceneFlowNode) => void }) {
  const node = entity.node;
  const distribution = node.kind === "source" ? node.interarrivalTime : node.kind === "station" ? node.processingTime : undefined;
  const updateDistribution = (value: PlantLiteDistribution) => {
    if (node.kind === "source") onChange({ ...entity, node: { ...node, interarrivalTime: value } });
    if (node.kind === "station") onChange({ ...entity, node: { ...node, processingTime: value } });
  };
  return <div className="scene-flow-node-fields">
    <label><span>名称</span><input aria-label="物流节点名称" value={node.name} maxLength={120} onChange={event => onChange({ ...entity, node: { ...node, name: event.target.value } })} /></label>
    {distribution && <>
      <label><span>{node.kind === "source" ? "到料间隔（分）" : "处理时间（分）"}</span><input type="number" min={0.01} step={0.1} value={distributionTypicalValue(distribution)} onChange={event => { if (Number.isFinite(event.target.valueAsNumber) && event.target.valueAsNumber > 0) updateDistribution(setDistributionTypicalValue(distribution, event.target.valueAsNumber)); }} /></label>
      <label><span>时间分布</span><select value={distribution.kind} onChange={event => updateDistribution(changeDistributionKind(distribution, event.target.value as PlantLiteDistribution["kind"]))}><option value="deterministic">固定值</option><option value="exponential">指数分布</option><option value="uniform">均匀分布</option><option value="normal">正态分布</option></select></label>
      {distribution.kind === "uniform" && <><NumberField label="最小值" value={distribution.minimum} onChange={minimum => updateDistribution({ ...distribution, minimum })} /><NumberField label="最大值" value={distribution.maximum} onChange={maximum => updateDistribution({ ...distribution, maximum })} /></>}
      {distribution.kind === "normal" && <NumberField label="标准差" value={distribution.standardDeviation} onChange={standardDeviation => updateDistribution({ ...distribution, standardDeviation })} />}
    </>}
    {(node.kind === "buffer" || node.kind === "queue-buffer" || node.kind === "station") && <NumberField label={node.kind === "station" ? "并行工位数" : "队列容量"} value={node.capacity ?? 1} integer onChange={capacity => onChange({ ...entity, node: { ...node, capacity } })} />}
    {node.kind === "station" && <NumberField label="等待队列容量" value={node.queueCapacity ?? 20} integer onChange={queueCapacity => onChange({ ...entity, node: { ...node, queueCapacity } })} />}
  </div>;
}

function NumberField({ label, value, integer = false, onChange }: { label: string; value: number; integer?: boolean; onChange: (value: number) => void }) {
  return <label><span>{label}</span><input type="number" min={integer ? 1 : 0.01} step={integer ? 1 : 0.1} value={value} onChange={event => { const next = event.target.valueAsNumber; if (Number.isFinite(next) && next > 0 && (!integer || Number.isInteger(next))) onChange(next); }} /></label>;
}
