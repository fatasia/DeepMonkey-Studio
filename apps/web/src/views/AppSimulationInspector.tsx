import { X } from "lucide-react";
import type { SimulationEntityState } from "@bim-studio/contracts";
import { SceneSimulationEntityInspector } from "../components/SceneSimulationEntityInspector";
import { translate as tr } from "../i18n";
import type { AppStudioController } from "./AppStudioShell";

export function AppSimulationInspector({ controller, entity, onClose }: {
  controller: AppStudioController;
  entity: SimulationEntityState;
  onClose: () => void;
}) {
  const { locale, loadedModels, bindings } = controller;
  return <aside className="right-panel" aria-label={tr(locale, "仿真实体检查器", "Simulation entity inspector")}>
    <div className="panel-heading inspector-heading">
      <h2>{tr(locale, "属性检查器", "Inspector")}</h2>
      <button type="button" className="button ghost icon-only" aria-label={tr(locale, "退出仿真实体选择", "Clear simulation selection")} onClick={onClose}><X size={16} /></button>
    </div>
    <SceneSimulationEntityInspector
      locale={locale}
      entity={entity}
      modelNames={new Map(loadedModels.map((model) => [model.id, model.name]))}
      onChange={bindings.scenePersistence.updateSimulationEntity}
      onDelete={() => { bindings.scenePersistence.deleteSimulationEntity(entity.id); onClose(); }}
    />
  </aside>;
}
