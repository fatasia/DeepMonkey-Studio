import { TimerReset } from "lucide-react";
import type { PlantLiteStudyRecord } from "@bim-studio/contracts";
import { plantLiteMeasurementEvidenceText } from "./plantLiteMeasurementWindow";

export function PlantLiteMeasurementWindowEvidence({ result }: { result: PlantLiteStudyRecord }) {
  return (
    <div className="logistics-evidence verified" aria-label="仿真统计窗口证据">
      <TimerReset size={15} />
      <span>{plantLiteMeasurementEvidenceText(result)}</span>
    </div>
  );
}
