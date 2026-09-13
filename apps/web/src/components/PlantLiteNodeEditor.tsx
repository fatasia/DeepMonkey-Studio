import { ChevronDown, GripVertical, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  plantLiteEffectiveCapacity,
  type Distribution,
  type PlantLiteModel,
  type PlantLiteNode,
  type PlantLiteResource,
} from "@bim-studio/plant-lite-simulation";
import {
  PLANT_NODE_LABELS,
  bindPlantLiteStationWorkerPool,
  changeDistributionKind,
  createPlantLiteStationWorkerPool,
  distributionTypicalValue,
  replacePlantLiteNode,
  replacePlantLiteResource,
  setPlantLiteStationEquipment,
  setPlantLiteStationWorker,
  setDistributionTypicalValue,
} from "./plantLiteModelEditing";
import { PlantLitePowerProfileControls } from "./PlantLiteEnergyControls";
import { PlantLiteShiftWindowsEditor } from "./PlantLiteShiftWindowsEditor";
import { PlantLiteChangeoverEditor } from "./PlantLiteChangeoverEditor";
import { PlantLiteQualityControls } from "./PlantLiteQualityControls";
import {
  ensurePlantLiteEnergyEconomics,
  setPlantLiteResourcePower,
  setPlantLiteStationPower,
} from "./plantLiteEnergyEditing";

export function PlantLiteNodeEditor({
  model,
  node,
  index,
  dragging,
  onModelChange,
  onRemove,
  onDragStart,
  onDragEnd,
  onDrop,
}: {
  model: PlantLiteModel;
  node: PlantLiteNode;
  index: number;
  dragging: boolean;
  onModelChange: (model: PlantLiteModel) => void;
  onRemove: () => void;
  onDragStart: () => void;
  onDragEnd: () => void;
  onDrop: (movingId: string) => void;
}) {
  const replace = (replacement: PlantLiteNode) => onModelChange(replacePlantLiteNode(model, replacement));
  const canonicalKind = node.kind === "buffer" ? "queue-buffer" : node.kind;
  return (
    <article
      className={`plant-flow-node kind-${canonicalKind}${dragging ? " is-dragging" : ""}`}
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => { event.preventDefault(); onDrop(event.dataTransfer.getData("text/plain")); }}
    >
      <div className="plant-flow-node-main">
        <span
          className="plant-flow-grip"
          title={node.kind === "source" || node.kind === "sink" ? "起点和终点保持固定" : "拖动改变流程顺序"}
          draggable={node.kind !== "source" && node.kind !== "sink"}
          onDragStart={(event) => {
            event.dataTransfer.effectAllowed = "move";
            event.dataTransfer.setData("text/plain", node.id);
            onDragStart();
          }}
          onDragEnd={onDragEnd}
        ><GripVertical size={15} /><b>{index + 1}</b></span>
        <span className="plant-flow-kind">{PLANT_NODE_LABELS[canonicalKind]}</span>
        <label className="plant-flow-name"><span>名称</span><input aria-label={`${PLANT_NODE_LABELS[canonicalKind]}名称`} value={node.name} maxLength={120} onChange={(event) => replace({ ...node, name: event.target.value })} /></label>
        <PrimaryNodeControl model={model} node={node} onModelChange={onModelChange} onNodeChange={replace} />
        <button className="plant-flow-delete" type="button" title="删除节点" aria-label={`删除${node.name}`} onClick={onRemove}><Trash2 size={14} /></button>
      </div>
      {node.kind !== "sink" && <NodeAdvanced model={model} node={node} onModelChange={onModelChange} onNodeChange={replace} />}
    </article>
  );
}

function PrimaryNodeControl({ model, node, onModelChange, onNodeChange }: {
  model: PlantLiteModel;
  node: PlantLiteNode;
  onModelChange: (model: PlantLiteModel) => void;
  onNodeChange: (node: PlantLiteNode) => void;
}) {
  if (node.kind === "source") return <DistributionPrimary label="到料间隔" distribution={node.interarrivalTime} onChange={(interarrivalTime) => onNodeChange({ ...node, interarrivalTime })} />;
  if (node.kind === "station") return <><DistributionPrimary label="加工节拍" distribution={node.processingTime} onChange={(processingTime) => onNodeChange({ ...node, processingTime })} /><NumberField compact label="并行数" value={node.capacity ?? 1} min={1} onChange={(capacity) => onNodeChange({ ...node, capacity })} /></>;
  if (node.kind === "buffer" || node.kind === "queue-buffer") return <NumberField compact label="容量" value={node.capacity} min={1} onChange={(capacity) => onNodeChange({ ...node, capacity })} />;
  if (node.kind === "transport") {
    const resource = model.resources?.find((item) => item.id === node.resourceId);
    return <>{node.journey ? <span title="耗时由轨道长度、速度、装卸与路段让行计算；展开车辆与轨道调整">轨道调度 · {node.journey.speedMetersPerMinute} 米/分</span> : <DistributionPrimary label="搬运耗时" distribution={node.travelTime} onChange={(travelTime) => onNodeChange({ ...node, travelTime })} />}<NumberField compact label="共享资源数" value={resource?.capacity ?? 1} min={1} max={100} onChange={(capacity) => resource && onModelChange(replacePlantLiteResource(model, resource.id, { ...resource, capacity }))} /></>;
  }
  return <span className="plant-flow-terminal">流程终点</span>;
}

function DistributionPrimary({ label, distribution, onChange }: { label: string; distribution: Distribution; onChange: (value: Distribution) => void }) {
  return <NumberField compact label={`${label}（分）`} value={distributionTypicalValue(distribution)} min={0.01} step={0.1} onChange={(value) => onChange(setDistributionTypicalValue(distribution, value))} />;
}

function NodeAdvanced({ model, node, onModelChange, onNodeChange }: {
  model: PlantLiteModel;
  node: Exclude<PlantLiteNode, { kind: "sink" }>;
  onModelChange: (model: PlantLiteModel) => void;
  onNodeChange: (node: PlantLiteNode) => void;
}) {
  const distribution = node.kind === "source" ? node.interarrivalTime : node.kind === "station" ? node.processingTime : node.kind === "transport" && !node.journey ? node.travelTime : undefined;
  const setDistribution = (value: Distribution) => {
    if (node.kind === "source") onNodeChange({ ...node, interarrivalTime: value });
    else if (node.kind === "station") onNodeChange({ ...node, processingTime: value });
    else if (node.kind === "transport") onNodeChange({ ...node, travelTime: value });
  };
  return (
    <details className="plant-flow-advanced">
      <summary><ChevronDown size={13} />高级参数</summary>
      <div>
        {distribution && <DistributionAdvanced value={distribution} onChange={setDistribution} />}
        {node.kind === "source" && <><NumberField label="初始延迟（分）" value={node.initialDelay ?? 0} min={0} step={0.1} onChange={(initialDelay) => onNodeChange({ ...node, initialDelay })} /><NumberField label="最大投放量" value={node.maxItems ?? 1_000} min={1} onChange={(maxItems) => onNodeChange({ ...node, maxItems })} /></>}
        {node.kind === "station" && <><NumberField label="等待队列容量" value={node.queueCapacity ?? 100} min={1} onChange={(queueCapacity) => onNodeChange({ ...node, queueCapacity })} /><PlantLiteShiftWindowsEditor label="启用工位班次约束" value={node.availability} onChange={(availability) => onNodeChange(withNodeAvailability(node, availability))} /><PlantLiteQualityControls station={node} onChange={(station) => onNodeChange(station)} /><PlantLiteChangeoverEditor model={model} station={node} onChange={onModelChange} /><StationEquipmentAdvanced model={model} node={node} onModelChange={onModelChange} /><StationWorkerAdvanced model={model} node={node} onModelChange={onModelChange} />{!node.resourceId && <PlantLitePowerProfileControls profile={node.power} kind="station" label="计入工位能耗" onChange={(power) => onModelChange(setPlantLiteStationPower(ensurePlantLiteEnergyEconomics(model), node.id, power))} />}</>}
        {node.kind === "transport" && <><NumberField label="等待队列容量" value={node.queueCapacity ?? 100} min={1} onChange={(queueCapacity) => onNodeChange({ ...node, queueCapacity })} /><TransportResourceAdvanced model={model} resourceId={node.resourceId} onModelChange={onModelChange} /></>}
      </div>
    </details>
  );
}

function StationEquipmentAdvanced({ model, node, onModelChange }: {
  model: PlantLiteModel;
  node: Extract<PlantLiteNode, { kind: "station" }>;
  onModelChange: (model: PlantLiteModel) => void;
}) {
  const resource = model.resources?.find((item) => item.id === node.resourceId && item.kind === "equipment");
  const replace = (next: PlantLiteResource) => resource && onModelChange(replacePlantLiteResource(model, resource.id, next));
  return <div className="plant-resource-advanced">
    <label className="plant-option-toggle"><input type="checkbox" checked={Boolean(resource)} onChange={(event) => onModelChange(setPlantLiteStationEquipment(model, node.id, event.target.checked))} /><span>启用设备资源</span></label>
    {resource && <>
      <label><span>设备名称</span><input value={resource.name} maxLength={120} onChange={(event) => replace({ ...resource, name: event.target.value })} /></label>
      <NumberField label="设备数" value={resource.capacity} min={1} max={100} onChange={(capacity) => replace({ ...resource, capacity })} />
      <small className="plant-capacity-note">有效并行能力 {plantLiteEffectiveCapacity(model, node)}，由工位、设备与已启用人工池的容量共同约束。</small>
      <ResourceFailureControls resource={resource} replace={replace} />
      <PlantLitePowerProfileControls profile={resource.power} kind="equipment" label="计入设备能耗" onChange={(power) => onModelChange(setPlantLiteResourcePower(ensurePlantLiteEnergyEconomics(model), resource.id, power))} />
    </>}
  </div>;
}

function StationWorkerAdvanced({ model, node, onModelChange }: {
  model: PlantLiteModel;
  node: Extract<PlantLiteNode, { kind: "station" }>;
  onModelChange: (model: PlantLiteModel) => void;
}) {
  const workerPools = model.resources?.filter((item) => item.kind === "worker") ?? [];
  const resource = workerPools.find((item) => item.id === node.workerResourceId);
  const sharedStationCount = resource
    ? model.nodes.filter((candidate) => candidate.kind === "station" && candidate.workerResourceId === resource.id).length
    : 0;
  const replace = (next: PlantLiteResource) => resource && onModelChange(replacePlantLiteResource(model, resource.id, next));
  return <div className="plant-resource-advanced plant-worker-advanced">
    <label className="plant-option-toggle"><input type="checkbox" checked={Boolean(resource)} onChange={(event) => onModelChange(setPlantLiteStationWorker(model, node.id, event.target.checked))} /><span>启用人工资源约束</span></label>
    {resource && <>
      <label><span>人员池</span><select aria-label={`${node.name}人员池`} value={resource.id} onChange={(event) => onModelChange(bindPlantLiteStationWorkerPool(model, node.id, event.target.value))}>{workerPools.map((pool) => <option key={pool.id} value={pool.id}>{pool.name} · {pool.capacity} 人</option>)}</select></label>
      <label><span>人员池名称</span><input value={resource.name} maxLength={120} onChange={(event) => replace({ ...resource, name: event.target.value })} /></label>
      <NumberField label="同班人数" value={resource.capacity} min={1} max={500} onChange={(capacity) => replace({ ...resource, capacity })} />
      <div className="plant-worker-summary">
        <small>有效并行 {plantLiteEffectiveCapacity(model, node)}；工位、设备、人员均有空闲才会原子派工。{sharedStationCount > 1 ? `当前 ${sharedStationCount} 个工位共享此人员池并竞争人数。` : "当前为该工位独立人员池。"}</small>
        {sharedStationCount > 1 && <button type="button" onClick={() => onModelChange(createPlantLiteStationWorkerPool(model, node.id))}>拆分为独立池</button>}
      </div>
      <PlantLiteShiftWindowsEditor label="启用人员班次" value={resource.availability} onChange={(availability) => replace(withResourceAvailability(resource, availability))} />
    </>}
  </div>;
}

function DistributionAdvanced({ value, onChange }: { value: Distribution; onChange: (value: Distribution) => void }) {
  return <div className="plant-distribution-editor">
    <label><span>波动模型</span><select value={value.kind} onChange={(event) => onChange(changeDistributionKind(value, event.target.value as Distribution["kind"]))}><option value="deterministic">固定值</option><option value="uniform">均匀分布</option><option value="normal">正态分布</option><option value="exponential">指数分布</option></select></label>
    {value.kind === "uniform" && <><NumberField label="最小值" value={value.minimum} min={0.01} step={0.1} onChange={(minimum) => onChange({ ...value, minimum })} /><NumberField label="最大值" value={value.maximum} min={0.01} step={0.1} onChange={(maximum) => onChange({ ...value, maximum })} /></>}
    {value.kind === "normal" && <><NumberField label="标准差" value={value.standardDeviation} min={0.01} step={0.1} onChange={(standardDeviation) => onChange({ ...value, standardDeviation })} /><NumberField label="最小值" value={value.minimum ?? 0.01} min={0} step={0.1} onChange={(minimum) => onChange({ ...value, minimum })} /></>}
  </div>;
}

function TransportResourceAdvanced({ model, resourceId, onModelChange }: { model: PlantLiteModel; resourceId: string; onModelChange: (model: PlantLiteModel) => void }) {
  const resource = model.resources?.find((item) => item.id === resourceId);
  if (!resource || resource.kind === "worker") return null;
  const replace = (next: typeof resource) => onModelChange(replacePlantLiteResource(model, resource.id, next));
  return <div className="plant-resource-advanced">
    <label><span>资源名称</span><input value={resource.name} maxLength={120} onChange={(event) => replace({ ...resource, name: event.target.value })} /></label>
    <PlantLiteShiftWindowsEditor label="启用班次约束" value={resource.availability} onChange={(availability) => replace(withResourceAvailability(resource, availability))} />
    <ResourceFailureControls resource={resource} replace={replace} />
    <PlantLitePowerProfileControls profile={resource.power} kind={resource.kind} label="计入搬运能耗" onChange={(power) => onModelChange(setPlantLiteResourcePower(ensurePlantLiteEnergyEconomics(model), resource.id, power))} />
  </div>;
}

function withNodeAvailability(
  node: Extract<PlantLiteNode, { kind: "station" }>,
  availability: Extract<PlantLiteNode, { kind: "station" }>["availability"],
): Extract<PlantLiteNode, { kind: "station" }> {
  if (availability) return { ...node, availability };
  const { availability: _availability, ...rest } = node;
  return rest;
}

function withResourceAvailability(
  resource: PlantLiteResource,
  availability: PlantLiteResource["availability"],
): PlantLiteResource {
  if (availability) return { ...resource, availability };
  const { availability: _availability, ...rest } = resource;
  return rest;
}

function ResourceFailureControls({ resource, replace }: { resource: PlantLiteResource; replace: (resource: PlantLiteResource) => void }) {
  const failure = resource.failure;
  const toggle = (enabled: boolean) => {
    if (enabled) return replace({ ...resource, failure: { timeToFailure: { kind: "exponential", mean: 720 }, repairTime: { kind: "deterministic", value: 10 } } });
    const { failure: _failure, ...withoutFailure } = resource;
    replace(withoutFailure);
  };
  return <>
    <label className="plant-option-toggle"><input type="checkbox" checked={Boolean(failure)} onChange={(event) => toggle(event.target.checked)} /><span>启用随机故障（MTBF / MTTR）</span></label>
    {failure && <><NumberField label="MTBF 运行间隔（分）" value={distributionTypicalValue(failure.timeToFailure)} min={0.01} onChange={(mean) => replace({ ...resource, failure: { timeToFailure: { kind: "exponential", mean }, repairTime: failure.repairTime } })} /><NumberField label="MTTR 日历修复时间（分）" value={distributionTypicalValue(failure.repairTime)} min={0.01} onChange={(value) => replace({ ...resource, failure: { timeToFailure: failure.timeToFailure, repairTime: { kind: "deterministic", value } } })} /><small className="plant-capacity-note">每台资源独立故障；MTBF 只在班次运行时推进，MTTR 按日历时间修复，已开工作业非抢占完成。</small></>}
  </>;
}

function NumberField({ label, value, min, max, step = 1, compact = false, onChange }: { label: string; value: number; min?: number; max?: number; step?: number; compact?: boolean; onChange: (value: number) => void }) {
  const [draft, setDraft] = useState(() => Number.isFinite(value) ? String(value) : "");
  const editing = useRef(false);
  useEffect(() => {
    if (!editing.current) setDraft(Number.isFinite(value) ? String(value) : "");
  }, [value]);
  const commit = (raw: string) => {
    const numeric = Number(raw);
    if (raw.trim() && Number.isFinite(numeric)) onChange(numeric);
  };
  return <label className={compact ? "plant-number-field is-compact" : "plant-number-field"}>
    <span>{label}</span>
    <input
      type="number"
      value={draft}
      min={min}
      max={max}
      step={step}
      onFocus={() => { editing.current = true; }}
      onChange={(event) => {
        const raw = event.target.value;
        setDraft(raw);
        if (!raw.endsWith(".") && raw !== "-" && raw !== "+") commit(raw);
      }}
      onBlur={() => {
        editing.current = false;
        commit(draft);
        if (!draft.trim() || !Number.isFinite(Number(draft))) setDraft(Number.isFinite(value) ? String(value) : "");
      }}
    />
  </label>;
}
