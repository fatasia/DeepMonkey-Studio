import type { PlantLiteAvailability, PlantLiteShiftWindow } from "@bim-studio/contracts";
import { Clock3, Plus, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import "./PlantLiteShiftWindowsEditor.css";

const MAX_SHIFT_WINDOWS = 8;

export function PlantLiteShiftWindowsEditor({
  label,
  value,
  onChange,
}: {
  label: string;
  value?: PlantLiteAvailability | undefined;
  onChange: (value: PlantLiteAvailability | undefined) => void;
}) {
  const shifts = value?.shifts ?? [];
  const issue = shiftWindowsIssue(shifts);
  const suggested = nextShiftWindow(shifts);
  const replace = (index: number, patch: Partial<PlantLiteShiftWindow>) => onChange({
    shifts: shifts.map((shift, shiftIndex) => shiftIndex === index ? { ...shift, ...patch } : shift),
  });
  const remove = (index: number) => {
    const next = shifts.filter((_, shiftIndex) => shiftIndex !== index);
    onChange(next.length ? { shifts: next } : undefined);
  };

  return <div className={`plant-shift-editor${issue ? " has-issue" : ""}`}>
    <label className="plant-option-toggle">
      <input
        type="checkbox"
        checked={shifts.length > 0}
        onChange={(event) => onChange(event.target.checked ? { shifts: [{ startMinute: 0, endMinute: 480 }] } : undefined)}
      />
      <span>{label}</span>
    </label>
    {shifts.length > 0 && <div className="plant-shift-list">
      {shifts.map((shift, index) => <div className="plant-shift-row" key={`${index}:${shift.startMinute}:${shift.endMinute}`}>
        <span><Clock3 size={12} /><b>班次 {index + 1}</b><small>{formatShiftWindow(shift)}</small></span>
        <MinuteField label="开始" value={shift.startMinute} minimum={0} maximum={1439} onChange={(startMinute) => replace(index, { startMinute })} />
        <MinuteField label="结束" value={shift.endMinute} minimum={1} maximum={1440} onChange={(endMinute) => replace(index, { endMinute })} />
        <button type="button" className="plant-shift-remove" title={`删除班次 ${index + 1}`} aria-label={`删除班次 ${index + 1}`} onClick={() => remove(index)}><Trash2 size={13} /></button>
      </div>)}
      <div className="plant-shift-footer">
        <small>{issue ?? "每天按这些窗口循环；休班期间不启动新作业，已开工作业按当前非抢占策略完成。"}</small>
        <button
          type="button"
          disabled={!suggested || shifts.length >= MAX_SHIFT_WINDOWS}
          title={!suggested ? "当天已没有可追加的时间窗口" : "追加班次窗口"}
          onClick={() => suggested && onChange({ shifts: [...shifts, suggested] })}
        ><Plus size={12} />添加班次</button>
      </div>
    </div>}
  </div>;
}

/** 编辑期即时反馈；正式运行仍由 Plant 模型验证器阻断非法窗口。 */
export function shiftWindowsIssue(shifts: PlantLiteShiftWindow[]): string | undefined {
  const ordered = shifts
    .map((shift, index) => ({ ...shift, index }))
    .sort((left, right) => left.startMinute - right.startMinute || left.endMinute - right.endMinute);
  for (const shift of ordered) {
    if (!Number.isFinite(shift.startMinute) || !Number.isFinite(shift.endMinute)) return `班次 ${shift.index + 1} 的时间无效`;
    if (shift.startMinute < 0 || shift.endMinute > 1440 || shift.startMinute >= shift.endMinute) return `班次 ${shift.index + 1} 必须在当天范围内且结束晚于开始`;
  }
  for (let index = 1; index < ordered.length; index += 1) {
    if (ordered[index]!.startMinute < ordered[index - 1]!.endMinute) return `班次 ${ordered[index - 1]!.index + 1} 与班次 ${ordered[index]!.index + 1} 时间重叠`;
  }
  return undefined;
}

export function nextShiftWindow(shifts: PlantLiteShiftWindow[]): PlantLiteShiftWindow | undefined {
  if (!shifts.length) return { startMinute: 0, endMinute: 480 };
  const endMinute = Math.max(...shifts.map((shift) => shift.endMinute));
  if (!Number.isFinite(endMinute) || endMinute >= 1440) return undefined;
  const startMinute = Math.max(0, Math.floor(endMinute));
  return { startMinute, endMinute: Math.min(1440, startMinute + 480) };
}

function MinuteField({ label, value, minimum, maximum, onChange }: {
  label: string;
  value: number;
  minimum: number;
  maximum: number;
  onChange: (value: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));
  const editing = useRef(false);
  useEffect(() => { if (!editing.current) setDraft(String(value)); }, [value]);
  const commit = (raw: string) => {
    const numeric = Number(raw);
    if (!raw.trim() || !Number.isFinite(numeric)) return setDraft(String(value));
    const bounded = Math.min(maximum, Math.max(minimum, Math.round(numeric)));
    setDraft(String(bounded));
    onChange(bounded);
  };
  return <label className="plant-shift-minute">
    <span>{label}<small>{formatMinute(value)}</small></span>
    <input
      type="number"
      min={minimum}
      max={maximum}
      step={1}
      value={draft}
      onFocus={() => { editing.current = true; }}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => { editing.current = false; commit(draft); }}
      onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }}
    />
  </label>;
}

function formatShiftWindow(value: PlantLiteShiftWindow): string {
  return `${formatMinute(value.startMinute)}–${formatMinute(value.endMinute)}`;
}

function formatMinute(value: number): string {
  const bounded = Math.min(1440, Math.max(0, Number.isFinite(value) ? Math.round(value) : 0));
  if (bounded === 1440) return "24:00";
  return `${String(Math.floor(bounded / 60)).padStart(2, "0")}:${String(bounded % 60).padStart(2, "0")}`;
}
