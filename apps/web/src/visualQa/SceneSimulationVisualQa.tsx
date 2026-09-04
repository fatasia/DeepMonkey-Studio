import { useState } from "react";
import type { OperationsSnapshot } from "../api";
import { SceneSimulationPanel } from "../components/SceneSimulationPanel";
import type { SceneSimulationPanelId } from "../simulation/sceneSimulationRegistry";
import {
  industrialVisualQaPlantStudies,
  industrialVisualQaProject,
  industrialVisualQaScene,
} from "./industrialWorkflowFixtures";
import "./sceneSimulationVisualQa.css";

const snapshot: OperationsSnapshot = {
  models: [],
  deployments: [],
  assessments: [],
  shadowEvaluations: [],
  cases: [],
  logisticsExperiments: [],
  plantLiteStudies: industrialVisualQaPlantStudies,
  energyInsights: [],
  validationStudies: [],
  whatIfStudies: [],
  studies: [],
};

/** 稳定夹具用于验证插件壳、四入口和窄视口布局，不访问真实项目数据。 */
export default function SceneSimulationVisualQa() {
  const query = new URLSearchParams(window.location.search);
  const requested = query.get("panel");
  const [panelId, setPanelId] = useState<SceneSimulationPanelId>(
    requested === "workcell" || requested === "commissioning" || requested === "whatif" ? requested : "logistics",
  );

  return (
    <main className="scene-simulation-visual-qa">
      <div className="scene-simulation-visual-qa-grid" />
      <div className="scene-simulation-visual-qa-object"><i /><span>装配工位</span></div>
      <SceneSimulationPanel
        locale="zh-CN"
        panelId={panelId}
        project={industrialVisualQaProject}
        scenes={[industrialVisualQaScene]}
        activeScene={industrialVisualQaScene}
        selectedObjectId="robot-a"
        selectedObjectName="装配机器人 A"
        previewSnapshot={snapshot}
        onPanelChange={setPanelId}
        onOpenEvidence={() => undefined}
        onOpenDataCenter={() => undefined}
        onOpenSceneTarget={() => undefined}
        onClose={() => undefined}
      />
    </main>
  );
}
