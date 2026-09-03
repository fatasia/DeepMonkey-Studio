import { ChevronDown, Leaf, Zap } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { PlantLiteModel, PlantLitePowerProfile } from "@bim-studio/contracts";
import {
  countPlantLiteEnergyConsumers,
  defaultPlantLitePower,
  enablePlantLiteEnergyModel,
  setPlantLiteEnergyEconomics,
} from "./plantLiteEnergyEditing";

export function PlantLiteEnergyPolicyEditor({ model, onChange }: {
  model: PlantLiteModel;
  onChange: (model: PlantLiteModel) => void;
}) {
  const economics = model.energyEconomics;
  const consumers = countPlantLiteEnergyConsumers(model);
  const [open, setOpen] = useState(Boolean(economics));
  return (
    <details className="plant-energy-policy" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>
        <span><Leaf size={14} /><b>能耗、成本与碳排</b><small>{economics ? `${consumers} 个用能对象已建模` : "尚未建模"}</small></span>
        <ChevronDown size={14} />
      </summary>
      {!economics ? <div className="plant-energy-enable">
        <p>按运行、待机、班次和故障状态逐时间片累计。启用后先填入可编辑估值，运行前应按项目口径校准。</p>
        <button type="button" onClick={() => onChange(enablePlantLiteEnergyModel(model))}><Zap size={13} />启用能耗决策</button>
      </div> : <div className="plant-energy-policy-fields">
        <EnergyNumberInput
          label="综合电价（元/kWh）"
          value={economics.electricityPricePerKwh}
          min={0}
          step={0.01}
          onChange={(electricityPricePerKwh) => onChange(setPlantLiteEnergyEconomics(model, { ...economics, electricityPricePerKwh }))}
        />
        <EnergyNumberInput
          label="排放因子（kgCO₂e/kWh）"
          value={economics.carbonEmissionFactorKgPerKwh}
          min={0}
          step={0.001}
          onChange={(carbonEmissionFactorKgPerKwh) => onChange(setPlantLiteEnergyEconomics(model, { ...economics, carbonEmissionFactorKgPerKwh }))}
        />
        <label className="plant-number-field"><span>经济口径依据</span><select value={economics.source ?? "estimate"} onChange={(event) => onChange(setPlantLiteEnergyEconomics(model, { ...economics, source: event.target.value as "estimate" | "project" | "measured" }))}><option value="estimate">起步估值</option><option value="project">项目口径</option><option value="measured">实测 / 结算口径</option></select></label>
        <p>电价和排放因子随模型快照保存；工位与资源的功率在各自“高级参数”中调整。</p>
      </div>}
    </details>
  );
}

export function PlantLitePowerProfileControls({
  profile,
  kind,
  label,
  onChange,
}: {
  profile: PlantLitePowerProfile | undefined;
  kind: "station" | "agv" | "transport" | "equipment";
  label: string;
  onChange: (profile: PlantLitePowerProfile | undefined) => void;
}) {
  return <div className="plant-power-controls">
    <label className="plant-option-toggle">
      <input type="checkbox" checked={Boolean(profile)} onChange={(event) => onChange(event.target.checked ? defaultPlantLitePower(kind) : undefined)} />
      <span>{label}</span>
    </label>
    {profile ? <>
      <label className="plant-number-field"><span>功率依据</span><select value={profile.source ?? "estimate"} onChange={(event) => onChange({ ...profile, source: event.target.value as "estimate" | "nameplate" | "measured" })}><option value="estimate">工程估值</option><option value="nameplate">设备铭牌</option><option value="measured">现场实测</option></select></label>
      <EnergyNumberInput label="运行功率（kW/台）" value={profile.activePowerKw} min={0.01} step={0.1} onChange={(activePowerKw) => onChange({ ...profile, activePowerKw })} />
      <EnergyNumberInput label="待机功率（kW/台）" value={profile.idlePowerKw} min={0} step={0.1} onChange={(idlePowerKw) => onChange({ ...profile, idlePowerKw })} />
    </> : null}
  </div>;
}

function EnergyNumberInput({ label, value, min, step, onChange }: {
  label: string;
  value: number;
  min: number;
  step: number;
  onChange: (value: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));
  const editing = useRef(false);
  useEffect(() => { if (!editing.current) setDraft(String(value)); }, [value]);
  const commit = (raw: string) => {
    const numeric = Number(raw);
    if (raw.trim() && Number.isFinite(numeric)) onChange(numeric);
  };
  return <label className="plant-number-field"><span>{label}</span><input
    type="number"
    value={draft}
    min={min}
    step={step}
    onFocus={() => { editing.current = true; }}
    onChange={(event) => { setDraft(event.target.value); commit(event.target.value); }}
    onBlur={() => {
      editing.current = false;
      commit(draft);
      if (!draft.trim() || !Number.isFinite(Number(draft))) setDraft(String(value));
    }}
  /></label>;
}
