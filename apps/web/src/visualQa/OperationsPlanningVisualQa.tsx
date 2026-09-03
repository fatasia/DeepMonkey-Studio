import { useState } from "react";
import type { OperationsSnapshot } from "../api";
import { LogisticsOperationsPanel, type LogisticsStudyMode } from "../components/OperationsScenarioPanels";
import {
  defaultLogistics,
  defaultPlantLite,
  OperationsHeader,
  OperationsTabs,
} from "../components/operationsPresentation";
import {
  industrialVisualQaProject,
  industrialVisualQaPlantStudies,
  industrialVisualQaScene,
} from "./industrialWorkflowFixtures";

const emptySnapshot: OperationsSnapshot = {
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

/** 复用正式工厂规划组合，只隔离服务端写入，供浏览器门禁稳定重放。 */
export default function OperationsPlanningVisualQa() {
  const [logistics, setLogistics] = useState(defaultLogistics);
  const [plantLite, setPlantLite] = useState(defaultPlantLite);
  const [mode, setMode] = useState<LogisticsStudyMode>("des");

  return (
    <main className="operations-page operations-planning-visual-qa">
      <OperationsHeader project={industrialVisualQaProject} snapshot={emptySnapshot} onBack={() => undefined} />
      <OperationsTabs tab="logistics" onChange={() => undefined} />
      <section className="operations-content">
        <LogisticsOperationsPanel
          busy={false}
          logistics={logistics}
          plantLite={plantLite}
          mode={mode}
          snapshot={emptySnapshot}
          onChange={setLogistics}
          onPlantLiteChange={setPlantLite}
          onModeChange={setMode}
          onRun={() => undefined}
          onRunPlantLite={() => undefined}
          onRunPlantLiteSweep={() => undefined}
          onCancelPlantLite={() => undefined}
          onReproduce={() => undefined}
          onReproducePlantLite={() => undefined}
          project={industrialVisualQaProject}
          scenes={[industrialVisualQaScene]}
        />
      </section>
    </main>
  );
}
