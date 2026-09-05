import { useEffect, useMemo, useRef, useState } from "react";
import type { PlantLiteStudyRecord, SceneSnapshot, SimulationEntityState, Vector3Value } from "@bim-studio/contracts";
import { api } from "../api";
import { compileScenePlantModel, connectSceneFlowNodes, createSceneFlowNode, SCENE_FLOW_ROLES, type SceneFlowNode, type SceneFlowRole } from "../simulation/scenePlantModel";
import { SceneFlowNodeFields } from "./SceneFlowNodeFields";
import "./ScenePlantQuickRun.css";

export interface ScenePlantQuickRunProps {
  projectId: string;
  scene: SceneSnapshot;
  objects: ReadonlyArray<{ id: string; name: string }>;
  selectedObjectId?: string;
  resolvePosition: (id: string) => Vector3Value | undefined;
  onEntitiesChange: (entities: SimulationEntityState[]) => void;
  onStudy: (study: PlantLiteStudyRecord) => void;
}

/** 只编排现有作者合同、DES API 与 Study；不拥有播放时钟或另存结果。 */
export function ScenePlantQuickRun(props: ScenePlantQuickRunProps) {
  const [objectId, setObjectId] = useState(props.selectedObjectId ?? "");
  const [role, setRole] = useState<SceneFlowRole>("source");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [duration, setDuration] = useState(60);
  const [seed, setSeed] = useState("scene-1");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [study, setStudy] = useState<PlantLiteStudyRecord>();
  const request = useRef<AbortController | undefined>(undefined);
  useEffect(() => () => { request.current?.abort(); request.current = undefined; }, []);
  useEffect(() => { if (props.selectedObjectId) setObjectId(props.selectedObjectId); }, [props.selectedObjectId]);
  const entities = props.scene.simulationEntities ?? [];
  const nodes = entities.filter((entity): entity is SceneFlowNode => entity.kind === "flowNode");
  const compiled = useMemo(() => compileScenePlantModel(props.scene, props.resolvePosition), [props.scene, props.resolvePosition]);
  const object = props.objects.find(item => item.id === objectId);
  const bound = nodes.some(node => node.targetModelId === objectId);
  const change = (next: SimulationEntityState[]) => {
    try { props.onEntitiesChange(next); setError(""); } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  };
  async function run(reproduce = false) {
    if (request.current || (!reproduce && compiled.errors.length)) return;
    const controller = new AbortController(); request.current = controller; setBusy(true); setError("");
    try {
      const result = reproduce && study
        ? await api.reproducePlantLiteStudy(props.projectId, study.id, controller.signal)
        : await api.runPlantLiteStudy(props.projectId, { name: `${props.scene.name} · 场景物流`, model: compiled.model, seed, replications: 3, limits: { durationMinutes: duration, maxEvents: 100_000, maxResources: 100 }, trace: { replication: 0, maxItems: 100, maxEvents: 2_000 } }, controller.signal);
      if (request.current !== controller || controller.signal.aborted) return;
      setStudy(result); props.onStudy(result);
    } catch (reason) {
      if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (request.current === controller) { request.current = undefined; setBusy(false); }
    }
  }
  return <section className="scene-plant-quick" aria-label="场景物流建模">
    <header><strong>把场景对象变成物流流程</strong><p>绑定角色 → 连接流程 → 运行。参数随场景保存；结果进入统一 Study。</p></header>
    <fieldset disabled={busy}>
      <legend>1 · 绑定对象</legend>
      <div className="scene-plant-binding">
        <label><span>场景对象</span><select aria-label="物流场景对象" value={object ? objectId : ""} onChange={event => setObjectId(event.target.value)}><option value="">在视口点选或从这里选择</option>{props.objects.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
        <label><span>物流角色</span><select aria-label="物流角色" value={role} onChange={event => setRole(event.target.value as SceneFlowRole)}>{Object.entries(SCENE_FLOW_ROLES).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <button type="button" disabled={!object || bound} onClick={() => { if (object) change([...entities, createSceneFlowNode(object.id, object.name, role)]); }}>绑定</button>
      </div>
      {bound && <p>该对象已有物流角色，请在下方编辑参数。</p>}
      {nodes.map(entity => <details key={entity.id} className="scene-plant-node"><summary>{entity.node.name}<small>{SCENE_FLOW_ROLES[entity.node.kind as SceneFlowRole] ?? entity.node.kind}</small></summary><SceneFlowNodeFields entity={entity} onChange={next => change(entities.map(item => item.id === next.id ? next : item))} /><button type="button" className="scene-plant-remove" onClick={() => change(entities.filter(item => item.id !== entity.id && !(item.kind === "flowLink" && (item.fromModelId === entity.targetModelId || item.toModelId === entity.targetModelId))))}>移除角色与关联连线</button></details>)}
    </fieldset>
    <fieldset disabled={busy || nodes.length < 2}>
      <legend>2 · 连接流程</legend>
      <div className="scene-plant-binding">
        <label><span>起点</span><select aria-label="物流连线起点" value={from} onChange={event => setFrom(event.target.value)}><option value="">选择起点</option>{nodes.filter(node => node.node.kind !== "sink").map(node => <option key={node.id} value={node.targetModelId}>{node.node.name}</option>)}</select></label>
        <label><span>终点</span><select aria-label="物流连线终点" value={to} onChange={event => setTo(event.target.value)}><option value="">选择终点</option>{nodes.filter(node => node.node.kind !== "source").map(node => <option key={node.id} value={node.targetModelId}>{node.node.name}</option>)}</select></label>
        <button type="button" disabled={!from || !to || from === to} onClick={() => { try { change(connectSceneFlowNodes(entities, from, to)); } catch (reason) { setError(String(reason)); } }}>连接</button>
      </div>
      <ul className="scene-plant-links">{entities.filter(entity => entity.kind === "flowLink").map(link => <li key={link.id}><span>{nodes.find(node => node.targetModelId === link.fromModelId)?.node.name ?? "失效起点"} → {nodes.find(node => node.targetModelId === link.toModelId)?.node.name ?? "失效终点"}</span><button type="button" aria-label="移除物流连线" onClick={() => change(entities.filter(item => item.id !== link.id))}>移除</button></li>)}</ul>
    </fieldset>
    <fieldset disabled={busy}><legend>3 · 运行与存证</legend><div className="scene-plant-settings"><label><span>时长（分钟）</span><input aria-label="场景仿真时长" type="number" min={1} max={10080} value={duration} onChange={event => { if (event.target.valueAsNumber >= 1 && event.target.valueAsNumber <= 10080) setDuration(event.target.valueAsNumber); }} /></label><label><span>随机种子</span><input aria-label="场景仿真种子" maxLength={100} value={seed} onChange={event => setSeed(event.target.value)} /></label></div></fieldset>
    {compiled.errors.length > 0 && <details className="scene-plant-validation"><summary>还需完成 {compiled.errors.length} 项配置</summary><ul>{compiled.errors.map(message => <li key={message}>{message}</li>)}</ul></details>}
    {error && <p role="alert" className="scene-plant-error">{error}</p>}
    <div className="scene-plant-actions"><button type="button" className="primary" disabled={busy || compiled.errors.length > 0 || !seed.trim()} onClick={() => void run()}>{busy ? "运行并存证中…" : "运行场景物流"}</button>{busy && <button type="button" onClick={() => { request.current?.abort(); request.current = undefined; setBusy(false); setError("已停止等待；服务端若已完成，结果仍可在运营证据中查看。"); }}>停止等待</button>}</div>
    {study && <section className="scene-plant-result" aria-label="场景物流运行结果"><strong>{study.outcome.status === "completed" ? "运行完成" : "运行结果受限"} · {study.outcome.completedReplications}/{study.replications} 次重复</strong><p>吞吐 {study.outcome.throughputPerHour.mean.toFixed(1)} 件/时 · 平均在制 {study.outcome.averageWip.mean.toFixed(1)}</p><small>Study {study.id}</small>{study.outcome.message && <p>{study.outcome.message}</p>}<div className="scene-plant-actions"><button type="button" disabled={!study.trace || !study.model} onClick={() => props.onStudy(study)}>在时间线回放</button><button type="button" disabled={busy} onClick={() => void run(true)}>按原快照复现</button></div></section>}
  </section>;
}
