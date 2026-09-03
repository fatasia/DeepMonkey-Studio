import { VirtualCommissioningWorkbench } from "../components/VirtualCommissioningWorkbench";
import { WorkcellTrajectoryEvidence } from "../components/WorkcellTrajectoryEvidence";
import {
  completedControlValidation,
  completedWorkcellScreening,
  industrialVisualQaScene,
  industrialVisualQaTrajectories,
  industrialVisualQaTrajectoryAnalysis,
} from "./industrialWorkflowFixtures";
import "./commissioningVisualQa.css";

export default function CommissioningVisualQa() {
  const state = new URLSearchParams(window.location.search).get("state");
  const resultMode = state === "result";
  if (state === "trajectory") return <main className="operations-page commissioning-visual-qa trajectory-visual-qa">
    <section className="commissioning-trajectory-visual-frame">
      <WorkcellTrajectoryEvidence analysis={industrialVisualQaTrajectoryAnalysis} trajectories={industrialVisualQaTrajectories} onOpenObject={() => undefined} />
    </section>
  </main>;
  return <main className="operations-page commissioning-visual-qa">
    <VirtualCommissioningWorkbench
      projectId="visual-qa"
      scenes={[industrialVisualQaScene]}
      {...(resultMode ? { initialStudy: completedControlValidation } : {})}
      studies={resultMode ? [completedWorkcellScreening, completedControlValidation] : [completedWorkcellScreening]}
      onOpenTarget={() => undefined}
    />
  </main>;
}
