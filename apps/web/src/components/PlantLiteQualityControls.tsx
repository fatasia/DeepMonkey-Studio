import type { PlantLiteNode } from "@bim-studio/plant-lite-simulation";

type StationNode = Extract<PlantLiteNode, { kind: "station" }>;

/** 工位级一次通过判定；不把当前无环求解器包装成返工仿真。 */
export function PlantLiteQualityControls({ station, onChange }: {
  station: StationNode;
  onChange: (station: StationNode) => void;
}) {
  const enabled = station.yieldRate !== undefined;
  const setEnabled = (next: boolean) => {
    if (next) onChange({ ...station, yieldRate: 0.98 });
    else {
      const { yieldRate: _yieldRate, ...withoutYield } = station;
      onChange(withoutYield);
    }
  };
  return <div className="plant-quality-controls">
    <label className="plant-option-toggle">
      <input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />
      <span>启用工位良率与报废</span>
    </label>
    {enabled ? <label className="plant-number-field">
      <span>一次通过良率（%）</span>
      <input
        aria-label={`${station.name}一次通过良率`}
        type="number"
        min={0}
        max={100}
        step={0.1}
        value={Number(((station.yieldRate ?? 1) * 100).toFixed(3))}
        onChange={(event) => {
          const percent = Number(event.target.value);
          if (Number.isFinite(percent)) onChange({ ...station, yieldRate: Math.min(100, Math.max(0, percent)) / 100 });
        }}
      />
    </label> : null}
    {enabled ? <small className="plant-capacity-note">
      每件加工完成后使用独立随机流判定；报废件立即退出 WIP，不进入下游。当前不模拟返工循环。
    </small> : null}
  </div>;
}
