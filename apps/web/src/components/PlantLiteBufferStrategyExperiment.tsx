import { ArrowRight, Boxes, FlaskConical, LoaderCircle } from "lucide-react";
import { useState } from "react";
import type { PlantLiteStudyRecord, PlantLiteStudyRequest } from "@bim-studio/contracts";
import {
  createPlantLiteBufferStrategySweep,
  listPlantLiteBufferOptions,
} from "./plantLiteBufferStrategy";

export function PlantLiteBufferStrategyExperiment({
  study,
  busy,
  onRunSweep,
}: {
  study: PlantLiteStudyRecord;
  busy: boolean;
  onRunSweep: (requests: PlantLiteStudyRequest[]) => void;
}) {
  const buffers = listPlantLiteBufferOptions(study);
  const [requestedBufferId, setRequestedBufferId] = useState(buffers[0]?.id ?? "");
  const selected = buffers.find((buffer) => buffer.id === requestedBufferId) ?? buffers[0];
  if (!selected) return null;
  const sweep = createPlantLiteBufferStrategySweep(study, selected.id);

  return <section className="plant-buffer-strategy" aria-label="缓冲区策略实验">
    <span className="plant-buffer-strategy-title">
      <Boxes size={14} />
      <b>缓冲区策略实验</b>
      <small>单变量 · 固定随机条件</small>
    </span>
    <label>
      <span>缓冲区</span>
      <select aria-label="选择缓冲区" value={selected.id} onChange={(event) => setRequestedBufferId(event.target.value)}>
        {buffers.map((buffer) => <option key={buffer.id} value={buffer.id}>{buffer.name}</option>)}
      </select>
    </label>
    <div className="plant-buffer-strategy-values" aria-label={`当前容量 ${selected.capacity} 件及候选容量`}>
      <strong>基线 {selected.capacity} 件</strong>
      <ArrowRight size={13} />
      <span>
        {sweep?.candidates.map((candidate) => <em
          key={candidate.capacity}
          className={`is-${candidate.direction}`}
          title={candidate.label}
        >{candidate.direction === "reduce" ? "减至" : "扩至"} {candidate.capacity}</em>)}
      </span>
    </div>
    <button
      type="button"
      disabled={busy || !sweep}
      aria-busy={busy}
      title={sweep ? "保持基线 seed、重复次数、运行上限、轨迹和验收目标不变" : "当前容量位于策略边界，无法生成有效候选"}
      onClick={() => sweep && onRunSweep(sweep.requests)}
    >
      {busy ? <LoaderCircle className="spin" size={13} /> : <FlaskConical size={13} />}
      {busy ? "运行中" : sweep ? `运行 ${sweep.requests.length} 个方案` : "无有效候选"}
    </button>
  </section>;
}
