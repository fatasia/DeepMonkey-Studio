import { ArrowRight, RefreshCcw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { PlantLiteModel, PlantLiteStationNode } from "@bim-studio/contracts";
import { setPlantLiteChangeoverMinutes } from "./plantLiteMixEditing";

export function PlantLiteChangeoverEditor({ model, station, onChange }: {
  model: PlantLiteModel;
  station: PlantLiteStationNode;
  onChange: (model: PlantLiteModel) => void;
}) {
  const productTypes = model.productTypes ?? [];
  const pairs = productTypes.flatMap((from) => productTypes
    .filter((to) => to.id !== from.id)
    .map((to) => ({ from, to })));
  const serial = (station.capacity ?? 1) === 1;
  return <section className="plant-changeover-editor" aria-label={`${station.name}换型矩阵`}>
    <header>
      <span><RefreshCcw size={13} /><b>序列相关换型</b></span>
      <small>{station.changeovers?.length ?? 0} 个有向规则</small>
    </header>
    {!productTypes.length
      ? <p>先在“产品组合与混流”中配置产品类型，才能填写换型矩阵。</p>
      : !serial
        ? <p className="is-warning">换型矩阵只对单机工位生效；请先把并行数调整为 1。</p>
        : <>
          <p>按“前一产品 → 下一产品”填写分钟；方向可不同，留空或 0 明确表示该方向不换型，系统不会推断时长。</p>
          <div className="plant-changeover-matrix">
            {pairs.map(({ from, to }) => {
              const rule = station.changeovers?.find((candidate) =>
                candidate.fromProductTypeId === from.id && candidate.toProductTypeId === to.id);
              return <label key={`${from.id}\u0000${to.id}`}>
                <span title={`${from.name} (${from.id})`}>{from.name}</span>
                <ArrowRight size={11} />
                <span title={`${to.name} (${to.id})`}>{to.name}</span>
                <ChangeoverMinutesInput
                  value={rule?.minutes}
                  label={`${from.name}到${to.name}换型分钟`}
                  onChange={(minutes) => onChange(setPlantLiteChangeoverMinutes(model, station.id, from.id, to.id, minutes))}
                />
              </label>;
            })}
          </div>
        </>}
  </section>;
}

function ChangeoverMinutesInput({ value, label, onChange }: {
  value: number | undefined;
  label: string;
  onChange: (value: number | undefined) => void;
}) {
  const [draft, setDraft] = useState(value === undefined ? "" : String(value));
  const editing = useRef(false);
  useEffect(() => {
    if (!editing.current) setDraft(value === undefined ? "" : String(value));
  }, [value]);
  const commit = (raw: string) => {
    if (!raw.trim()) return onChange(undefined);
    const numeric = Number(raw);
    if (Number.isFinite(numeric) && numeric >= 0 && numeric <= 52_560) onChange(numeric || undefined);
  };
  return <span className="plant-changeover-minutes">
    <input
      aria-label={label}
      type="number"
      min={0}
      max={52560}
      step={0.1}
      placeholder="0"
      value={draft}
      onFocus={() => { editing.current = true; }}
      onChange={(event) => {
        const raw = event.target.value;
        setDraft(raw);
        if (!raw.endsWith(".")) commit(raw);
      }}
      onBlur={() => {
        editing.current = false;
        commit(draft);
        const numeric = Number(draft);
        if (!draft.trim() || !Number.isFinite(numeric) || numeric < 0 || numeric > 52_560) {
          setDraft(value === undefined ? "" : String(value));
        }
      }}
    />
    <i>分</i>
  </span>;
}
