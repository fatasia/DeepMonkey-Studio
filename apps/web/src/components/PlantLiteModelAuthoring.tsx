import { AlertTriangle, ArrowDown, ArrowUp, Boxes, ChevronDown, Factory, PackageCheck, PackagePlus, RotateCcw, Truck } from "lucide-react";
import { useMemo, useState } from "react";
import type { PlantLiteStudyRequest } from "@bim-studio/contracts";
import { createAgvLinePlantLiteModel, type PlantLiteModel } from "@bim-studio/plant-lite-simulation";
import { PlantLiteNodeEditor } from "./PlantLiteNodeEditor";
import { PlantLiteEnergyPolicyEditor } from "./PlantLiteEnergyControls";
import { PlantLiteProductMixEditor } from "./PlantLiteProductMixEditor";
import { PlantLiteAcceptanceTargetsEditor } from "./PlantLiteAcceptanceTargetsEditor";
import { PlantLiteProductionOrdersEditor } from "./PlantLiteProductionOrdersEditor";
import { PlantLiteModelExchange } from "./PlantLiteModelExchange";
import {
  PLANT_NODE_LABELS,
  addPlantLiteNode,
  movePlantLiteNode,
  plantLiteModelIssues,
  removePlantLiteNode,
  reorderPlantLiteNode,
  resetPlantLiteModel,
  type PlantLiteCanonicalNodeKind,
} from "./plantLiteModelEditing";

const NODE_ACTIONS: Array<{ kind: PlantLiteCanonicalNodeKind; icon: typeof Factory }> = [
  { kind: "source", icon: PackagePlus },
  { kind: "station", icon: Factory },
  { kind: "queue-buffer", icon: Boxes },
  { kind: "transport", icon: Truck },
  { kind: "sink", icon: PackageCheck },
];

export function PlantLiteModelAuthoring({ value, onChange }: { value: PlantLiteStudyRequest; onChange: (value: PlantLiteStudyRequest) => void }) {
  const model = useMemo(
    () => value.model ?? createAgvLinePlantLiteModel({
      ...(value.agvCount !== undefined ? { agvCount: value.agvCount } : {}),
      ...(value.bufferCapacity !== undefined ? { bufferCapacity: value.bufferCapacity } : {}),
    }),
    [value.model, value.agvCount, value.bufferCapacity],
  );
  const [draggingId, setDraggingId] = useState("");
  const issues = plantLiteModelIssues({ ...value, model });
  const durationMinutes = value.limits?.durationMinutes ?? 480;
  const warmupMinutes = value.limits?.warmupMinutes ?? 0;
  const measurementMinutes = Number.isFinite(durationMinutes) && Number.isFinite(warmupMinutes)
    ? durationMinutes - warmupMinutes
    : Number.NaN;
  const warmupMaximum = Number.isFinite(durationMinutes) && durationMinutes > 0.01 ? durationMinutes - 0.01 : 0;
  const setModel = (nextModel: PlantLiteModel) => onChange(withAuthoredModel(value, nextModel));
  const setName = (name: string) => onChange(withAuthoredModel({ ...value, name }, { ...model, name: name.trim() || model.name }));
  return (
    <div className="plant-authoring">
      <div className="plant-authoring-meta">
        <label><span>方案名称</span><input value={value.name} maxLength={80} onChange={(event) => setName(event.target.value)} /></label>
        <div className="plant-authoring-template">
          <span><b>{model.nodes.length}</b> 个节点 · <b>{model.edges.length}</b> 条顺序连接</span>
          <button type="button" onClick={() => onChange(resetPlantLiteModel(value))}><RotateCcw size={13} />恢复起步模板</button>
        </div>
      </div>

      <PlantLiteEnergyPolicyEditor model={model} onChange={setModel} />
      <PlantLiteProductMixEditor model={model} onChange={setModel} />
      <PlantLiteProductionOrdersEditor model={model} onChange={setModel} />
      <PlantLiteAcceptanceTargetsEditor value={value} onChange={onChange} />

      <section className="plant-flow-builder" aria-label="产线流程作者器">
        <header>
          <div><strong>产线流程</strong><small>添加节点后按列表顺序自动连接；拖动中间节点即可改工序顺序。</small></div>
          <div className="plant-node-actions">
            {NODE_ACTIONS.map(({ kind, icon: Icon }) => {
              const uniqueEndpointExists = (kind === "source" || kind === "sink") && model.nodes.some((node) => node.kind === kind);
              return <button
                key={kind}
                type="button"
                disabled={uniqueEndpointExists}
                title={uniqueEndpointExists ? `流程已有${PLANT_NODE_LABELS[kind]}` : `添加${PLANT_NODE_LABELS[kind]}`}
                onClick={() => setModel(addPlantLiteNode(model, kind))}
              ><Icon size={13} />{PLANT_NODE_LABELS[kind]}</button>;
            })}
          </div>
        </header>
        <div className="plant-flow-list">
          {model.nodes.map((node, index) => {
            const previous = model.nodes[index - 1];
            const next = model.nodes[index + 1];
            const canMoveUp = node.kind !== "source" && node.kind !== "sink" && previous?.kind !== "source";
            const canMoveDown = node.kind !== "source" && node.kind !== "sink" && next?.kind !== "sink";
            return <div className="plant-flow-entry" key={node.id}>
              <PlantLiteNodeEditor
                model={model}
                node={node}
                index={index}
                dragging={draggingId === node.id}
                onModelChange={setModel}
                onRemove={() => setModel(removePlantLiteNode(model, node.id))}
                onDragStart={() => setDraggingId(node.id)}
                onDragEnd={() => setDraggingId("")}
                onDrop={(transferredId) => {
                  const movingId = transferredId || draggingId;
                  if (movingId) setModel(reorderPlantLiteNode(model, movingId, node.id));
                  setDraggingId("");
                }}
              />
              <div className="plant-flow-order-actions" aria-label={`${node.name}顺序`}>
                <button type="button" disabled={!canMoveUp} title="上移" aria-label={`上移${node.name}`} onClick={() => setModel(movePlantLiteNode(model, node.id, -1))}><ArrowUp size={12} /></button>
                <button type="button" disabled={!canMoveDown} title="下移" aria-label={`下移${node.name}`} onClick={() => setModel(movePlantLiteNode(model, node.id, 1))}><ArrowDown size={12} /></button>
              </div>
              {next && <div className="plant-flow-link"><span /><ArrowDown size={13} /><small>连接至 {next.name}</small></div>}
            </div>;
          })}
        </div>
      </section>

      <details className="plant-run-advanced">
        <summary><ChevronDown size={13} /><span>高级运行设置</span><small>按需展开</small></summary>
        <div className="plant-run-settings">
          <label><span>随机种子</span><input value={String(value.seed ?? "")} maxLength={120} onChange={(event) => onChange({ ...value, seed: event.target.value })} /></label>
          <label><span>统计运行次数</span><input type="number" min={1} max={30} value={value.replications ?? 12} onChange={(event) => onChange({ ...value, replications: Number(event.target.value) })} /></label>
          <label><span>总运行时长（分钟）</span><input type="number" min={0.01} max={52560} step="any" value={durationMinutes} onChange={(event) => onChange({ ...value, limits: { ...value.limits, durationMinutes: Number(event.target.value) } })} /></label>
          <label><span>预热期（分钟）</span><input type="number" min={0} max={warmupMaximum} step="any" value={warmupMinutes} onChange={(event) => onChange({ ...value, limits: { ...value.limits, warmupMinutes: Number(event.target.value) } })} /></label>
          <small><b>{measurementMinutes > 0 ? `正式统计 ${measurementMinutes.toLocaleString("zh-CN")} 分钟` : "统计窗口无效"}</b> · 系统从空状态连续运行；吞吐与交付期只采集预热后的完工件，WIP、利用率、队列、停机和能耗只积分正式窗口。跨边界完工件保留完整交付期。</small>
        </div>
      </details>
      <PlantLiteModelExchange value={value} model={model} onChange={onChange} />
      {issues.length > 0 && <div className="plant-validation" role="alert"><AlertTriangle size={14} /><span><b>还不能运行</b>{issues.slice(0, 3).map((issue) => <small key={issue}>{issue}</small>)}</span></div>}
    </div>
  );
}

function withAuthoredModel(request: PlantLiteStudyRequest, model: PlantLiteModel): PlantLiteStudyRequest {
  const { agvCount: _agvCount, bufferCapacity: _bufferCapacity, ...rest } = request;
  return { ...rest, templateId: "agv-line-v1", model };
}
