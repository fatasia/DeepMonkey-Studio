import { Route, Trash2, Waypoints } from "lucide-react";
import type { SimulationEntityState } from "@bim-studio/contracts";
import { translate as tr } from "../i18n";
import type { AppLocale } from "../i18n";

export interface SceneSimulationEntityInspectorProps {
  locale: AppLocale;
  entity: SimulationEntityState;
  /** 引用模型的显示名，用于只读展示引用目标。 */
  modelNames: ReadonlyMap<string, string>;
  onChange: (next: SimulationEntityState) => void;
  onDelete: () => void;
}

/** 选中仿真实体时的配置面板（SIM-1a）：路径速度/循环、碰撞容差、连接只读+删除。 */
export function SceneSimulationEntityInspector(props: SceneSimulationEntityInspectorProps) {
  const { entity, locale } = props;
  const modelName = (id: string) => props.modelNames.get(id) ?? id;
  return (
    <div className="inspector-content simulation-entity-inspector">
      <div className="inspector-selection-context">
        <span className="inspector-selection-icon"><Waypoints size={16} /></span>
        <span>
          <strong>{entity.kind === "path" ? entity.name || tr(locale, "路径", "Path") : entity.kind === "collisionPair" ? entity.name || tr(locale, "碰撞对", "Collision pair") : tr(locale, "流程连接", "Flow link")}</strong>
          <small>{tr(locale, "仿真实体", "Simulation entity")}</small>
        </span>
      </div>
      {entity.kind === "flowLink" && (
        <section className="inspector-section">
          <label><span>{tr(locale, "源 → 目标", "From → To")}</span><output>{modelName(entity.fromModelId)} → {modelName(entity.toModelId)}</output></label>
        </section>
      )}
      {entity.kind === "path" && (
        <section className="inspector-section">
          <label><span>{tr(locale, "名称", "Name")}</span><input value={entity.name} onChange={(event) => props.onChange({ ...entity, name: event.target.value })} /></label>
          <label><span>{tr(locale, "速度", "Speed")}</span><input type="number" min={0} step={0.1} value={entity.speed} onChange={(event) => props.onChange({ ...entity, speed: Math.max(0, Number(event.target.value)) })} /></label>
          <label><span>{tr(locale, "循环", "Loop")}</span>
            <select value={entity.loopMode} onChange={(event) => props.onChange({ ...entity, loopMode: event.target.value as typeof entity.loopMode })}>
              <option value="once">{tr(locale, "单次", "Once")}</option>
              <option value="loop">{tr(locale, "循环", "Loop")}</option>
              <option value="pingpong">{tr(locale, "往返", "Ping-pong")}</option>
            </select>
          </label>
          <label><span>{tr(locale, "路径点", "Waypoints")}</span><output><Route size={12} /> {entity.points.length}</output></label>
          <label><span>{tr(locale, "目标模型", "Target model")}</span><output>{modelName(entity.targetModelId)}</output></label>
        </section>
      )}
      {entity.kind === "collisionPair" && (
        <section className="inspector-section">
          <label><span>{tr(locale, "名称", "Name")}</span><input value={entity.name} onChange={(event) => props.onChange({ ...entity, name: event.target.value })} /></label>
          <label><span>{tr(locale, "容差 (m)", "Tolerance (m)")}</span><input type="number" min={0} step={0.01} value={entity.tolerance} onChange={(event) => props.onChange({ ...entity, tolerance: Math.max(0, Number(event.target.value)) })} /></label>
          <label><span>{tr(locale, "侧 A", "Side A")}</span><output>{modelName(entity.a.modelId)}{entity.a.layerId ? ` / ${entity.a.layerId}` : ""}</output></label>
          <label><span>{tr(locale, "侧 B", "Side B")}</span><output>{modelName(entity.b.modelId)}{entity.b.layerId ? ` / ${entity.b.layerId}` : ""}</output></label>
        </section>
      )}
      <button className="danger" onClick={props.onDelete}><Trash2 size={13} />{tr(locale, "删除仿真实体", "Delete simulation entity")}</button>
    </div>
  );
}
