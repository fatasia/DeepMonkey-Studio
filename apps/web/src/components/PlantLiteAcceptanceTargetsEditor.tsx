import { ChevronDown, Target } from "lucide-react";
import type { PlantLiteStudyRequest } from "@bim-studio/contracts";
import {
  updatePlantLiteAcceptanceBasis,
  updatePlantLiteAcceptanceTarget,
  type PlantLiteNumericAcceptanceKey,
} from "./plantLiteAcceptanceEditing";

const FIELDS: Array<{ key: PlantLiteNumericAcceptanceKey; label: string; unit: string; step: string }> = [
  { key: "minimumThroughputPerHour", label: "最低吞吐", unit: "件/时", step: "0.1" },
  { key: "maximumAverageWip", label: "最大平均 WIP", unit: "件", step: "0.1" },
  { key: "maximumAverageLeadTimeMinutes", label: "最大交付周期", unit: "分钟", step: "0.1" },
  { key: "maximumEnergyPerCompletedItemKwh", label: "最大单位能耗", unit: "kWh/件", step: "0.001" },
  { key: "maximumElectricityCostPerCompletedItem", label: "最大单位电费", unit: "元/件", step: "0.001" },
  { key: "maximumCarbonEmissionPerCompletedItemKg", label: "最大单位碳排", unit: "kgCO₂e/件", step: "0.001" },
];

export function PlantLiteAcceptanceTargetsEditor({
  value,
  onChange,
}: {
  value: PlantLiteStudyRequest;
  onChange: (value: PlantLiteStudyRequest) => void;
}) {
  const count = FIELDS.filter(({ key }) => typeof value.acceptanceTargets?.[key] === "number").length;
  return <details className="plant-acceptance-targets">
    <summary>
      <span><Target size={14} /><b>方案验收目标</b><small>{count ? `${count} 项阈值已设置` : "可选 · 用 95% 区间判断达标风险"}</small></span>
      <ChevronDown size={14} />
    </summary>
    <div className="plant-acceptance-targets-body">
      <p>留空的指标不参与验收；区间跨过阈值会标为“风险”，不会用均值冒充稳定达标。</p>
      <label className="plant-acceptance-basis"><span>验收依据</span><input maxLength={160} placeholder="例如：方案冻结版 / 规划产能要求" value={value.acceptanceTargets?.basis ?? ""} onChange={(event) => onChange(updatePlantLiteAcceptanceBasis(value, event.target.value))} /></label>
      <div className="plant-acceptance-target-grid">
        {FIELDS.map((field) => <label key={field.key}>
          <span>{field.label}</span>
          <span className="plant-target-input"><input
            type="number"
            min="0.000001"
            step={field.step}
            placeholder="不限制"
            value={value.acceptanceTargets?.[field.key] ?? ""}
            onChange={(event) => onChange(updatePlantLiteAcceptanceTarget(value, field.key, optionalNumber(event.target.value)))}
          /><i>{field.unit}</i></span>
        </label>)}
      </div>
    </div>
  </details>;
}

function optionalNumber(value: string): number | undefined {
  return value.trim() ? Number(value) : undefined;
}
