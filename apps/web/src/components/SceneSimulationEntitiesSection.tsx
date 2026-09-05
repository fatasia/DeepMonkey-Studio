import { GitBranch, Route, Waypoints } from "lucide-react";
import type { SimulationEntityState } from "@bim-studio/contracts";
import { translate as tr } from "../i18n";
import type { AppLocale } from "../i18n";

export interface SceneSimulationEntitiesSectionProps {
  locale: AppLocale;
  entities: SimulationEntityState[] | undefined;
  /** 选中仿真实体（含类型），检查器据此切换配置面板；undefined 取消选择。 */
  selectedId: string | undefined;
  onSelect: (id: string | undefined) => void;
  /** 实体引用的模型被删除时黄牌提示（不静默失效，沿 Study 歧义防护原则）。 */
  brokenModelIds: ReadonlySet<string>;
}

function entityLabel(entity: SimulationEntityState, locale: AppLocale): string {
  if (entity.kind === "flowLink") return tr(locale, "流程连接", "Flow link");
  if (entity.kind === "path") return entity.name || tr(locale, "路径", "Path");
  return entity.name || tr(locale, "碰撞对", "Collision pair");
}

/** 场景树「仿真」域（SIM-1a）：只读列出持久化的仿真实体；创建/编辑在右侧检查器。 */
export function SceneSimulationEntitiesSection(props: SceneSimulationEntitiesSectionProps) {
  const entities = props.entities ?? [];
  if (entities.length === 0) return null;
  return (
    <section className="scene-simulation-entities" aria-label={tr(props.locale, "仿真实体", "Simulation entities")}>
      <div className="scene-tree-modebar">
        <span><Waypoints size={13} />{tr(props.locale, "仿真", "Simulation")}<small>{entities.length}</small></span>
      </div>
      <div className="scene-simulation-entity-list" role="tree" aria-label={tr(props.locale, "仿真实体树", "Simulation entity tree")}>
        {entities.map((entity) => {
          const broken = entity.kind === "flowLink"
            ? props.brokenModelIds.has(entity.fromModelId) || props.brokenModelIds.has(entity.toModelId)
            : entity.kind === "path"
              ? props.brokenModelIds.has(entity.targetModelId)
              : props.brokenModelIds.has(entity.a.modelId) || props.brokenModelIds.has(entity.b.modelId);
          const Icon = entity.kind === "flowLink" ? GitBranch : entity.kind === "path" ? Route : Waypoints;
          return (
            <div
              key={entity.id}
              role="treeitem"
              aria-selected={props.selectedId === entity.id}
              className={`scene-simulation-entity ${props.selectedId === entity.id ? "selected" : ""} ${broken ? "broken" : ""}`}
              title={broken ? tr(props.locale, "引用的场景对象已被删除", "Referenced scene object was deleted") : entityLabel(entity, props.locale)}
              onClick={() => props.onSelect(props.selectedId === entity.id ? undefined : entity.id)}
            >
              <Icon size={13} />
              <span>{entityLabel(entity, props.locale)}</span>
              {broken && <em>{tr(props.locale, "断链", "broken")}</em>}
            </div>
          );
        })}
      </div>
    </section>
  );
}
