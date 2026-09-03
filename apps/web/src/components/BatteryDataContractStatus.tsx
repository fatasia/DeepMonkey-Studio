import { AlertTriangle, CheckCircle2 } from "lucide-react";
import type { BatteryDataContractAssessment } from "@bim-studio/contracts";

export function BatteryDataContractStatus({ assessment }: { assessment: BatteryDataContractAssessment }) {
  const requiredMatches = assessment.matches.filter((match) => match.required);
  return (
    <section
      className={`battery-data-contract ${assessment.compatible ? "ready" : "blocked"}`}
      aria-live="polite"
      aria-label="电池数据字段合同"
    >
      <div>
        {assessment.compatible ? <CheckCircle2 size={14} /> : <AlertTriangle size={14} />}
        <strong>字段合同</strong>
        <span>{assessment.compatible ? "可运行" : `缺 ${assessment.missing.length} 项`}</span>
      </div>
      <p>
        {assessment.compatible
          ? `已匹配 ${requiredMatches.map((match) => match.label).join("、")}`
          : `需补充 ${assessment.missing.join("、")}`}
      </p>
      <small>{assessment.runtimeCheck}</small>
      {assessment.warnings.length > 0 && <small className="warning">{assessment.warnings.join("；")}</small>}
    </section>
  );
}
