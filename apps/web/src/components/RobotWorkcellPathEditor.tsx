import { ArrowDown, ArrowUp, GripVertical, Route, Trash2 } from "lucide-react";
import { useState, type DragEvent, type KeyboardEvent } from "react";
import type { RobotAssistantTargetInput } from "./robotWorkcellAssistantTypes";
import {
  changeRobotPathPointMode,
  isRobotPathPointEnabled,
  moveRobotPathPoint,
  moveRobotPathPointBefore,
  robotPathPointMode,
  type RobotPathPointMode,
} from "./robotWorkcellPathEditing";
import "./RobotWorkcellPathEditor.css";

export function RobotWorkcellPathEditor({ targets, onChange }: {
  targets: RobotAssistantTargetInput[];
  onChange: (targets: RobotAssistantTargetInput[]) => void;
}) {
  const [draggingId, setDraggingId] = useState<string>();
  const [dropTargetId, setDropTargetId] = useState<string>();
  const activeCount = targets.filter(isRobotPathPointEnabled).length;

  function update(targetId: string, updateTarget: (target: RobotAssistantTargetInput) => RobotAssistantTargetInput) {
    onChange(targets.map((target) => target.id === targetId ? updateTarget(target) : target));
  }
  function move(targetId: string, delta: -1 | 1) {
    const next = moveRobotPathPoint(targets, targetId, delta);
    if (next !== targets) onChange(next);
  }
  function keyboardMove(event: KeyboardEvent<HTMLLIElement>, targetId: string) {
    if (!event.altKey || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return;
    event.preventDefault();
    move(targetId, event.key === "ArrowUp" ? -1 : 1);
  }
  function beginDrag(event: DragEvent<HTMLElement>, targetId: string) {
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", targetId);
    setDraggingId(targetId);
  }
  function drop(event: DragEvent<HTMLLIElement>, destinationId: string) {
    event.preventDefault();
    const sourceId = draggingId ?? event.dataTransfer.getData("text/plain");
    const next = moveRobotPathPointBefore(targets, sourceId, destinationId);
    if (next !== targets) onChange(next);
    setDraggingId(undefined);
    setDropTargetId(undefined);
  }

  return <section className="robot-path-editor robot-assistant-target-times" aria-label="工艺点与路径序列">
    <header>
      <span><Route size={14} /><strong>工艺点与路径序列</strong><small>{activeCount}/{targets.length} 启用</small></span>
      <em>拖动或 Alt + ↑↓ 调整顺序</em>
    </header>
    <ol>
      {targets.map((target, index) => {
        const enabled = isRobotPathPointEnabled(target);
        const mode = robotPathPointMode(target);
        const cannotDisable = enabled && activeCount === 1;
        const cannotDelete = targets.length === 1 || (enabled && activeCount === 1);
        return <li
          key={target.id}
          className={`${enabled ? "" : "disabled"}${dropTargetId === target.id ? " drop-target" : ""}`}
          tabIndex={0}
          aria-label={`第 ${index + 1} 个工艺点：${target.name}`}
          onKeyDown={(event) => keyboardMove(event, target.id)}
          onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = "move"; setDropTargetId(target.id); }}
          onDragLeave={() => setDropTargetId((current) => current === target.id ? undefined : current)}
          onDrop={(event) => drop(event, target.id)}
        >
          <div className="robot-path-point-heading">
            <button
              type="button"
              className="robot-path-grip"
              draggable
              aria-label={`拖动 ${target.name} 调整顺序`}
              title="拖动调整顺序；也可按 Alt + ↑↓"
              onDragStart={(event) => beginDrag(event, target.id)}
              onDragEnd={() => { setDraggingId(undefined); setDropTargetId(undefined); }}
            ><GripVertical size={14} /></button>
            <i aria-hidden="true">{index + 1}</i>
            <span title={`${target.id} · (${format(target.position.x)}, ${format(target.position.y)}, ${format(target.position.z)})`}>
              <strong>{target.name}</strong>
              <small>X {format(target.position.x)} · Y {format(target.position.y)} · Z {format(target.position.z)}</small>
            </span>
            <label className="robot-path-switch" title={cannotDisable ? "至少保留一个启用工艺点" : enabled ? "停用工艺点" : "启用工艺点"}>
              <input
                type="checkbox"
                checked={enabled}
                disabled={cannotDisable}
                aria-label={`${enabled ? "停用" : "启用"} ${target.name}`}
                onChange={(event) => update(target.id, (item) => ({ ...item, enabled: event.target.checked }))}
              />
              <span>{enabled ? "启用" : "停用"}</span>
            </label>
          </div>
          <div className="robot-path-point-controls">
            <label>
              <span>动作</span>
              <select
                value={mode}
                aria-label={`${target.name} 动作类型`}
                disabled={!enabled}
                onChange={(event) => update(target.id, (item) => changeRobotPathPointMode(item, event.target.value as RobotPathPointMode))}
              >
                <option value="move">移动</option>
                <option value="process">移动 + 工艺</option>
                <option value="settle">移动 + 等待</option>
                <option value="process-settle">工艺 + 等待</option>
              </select>
            </label>
            <DurationField
              label="工艺驻留"
              value={target.processTimeSec ?? 0}
              disabled={!enabled}
              onChange={(value) => update(target.id, (item) => optionalDuration(item, "processTimeSec", value))}
            />
            <DurationField
              label="稳定等待"
              value={target.settleTimeSec ?? 0}
              disabled={!enabled}
              onChange={(value) => update(target.id, (item) => optionalDuration(item, "settleTimeSec", value))}
            />
            <div className="robot-path-row-actions">
              <button type="button" disabled={index === 0} aria-label={`上移 ${target.name}`} title="上移" onClick={() => move(target.id, -1)}><ArrowUp size={13} /></button>
              <button type="button" disabled={index === targets.length - 1} aria-label={`下移 ${target.name}`} title="下移" onClick={() => move(target.id, 1)}><ArrowDown size={13} /></button>
              <button
                type="button"
                className="danger"
                disabled={cannotDelete}
                aria-label={`删除 ${target.name}`}
                title={cannotDelete ? "至少保留一个启用工艺点" : "从任务草稿删除"}
                onClick={() => onChange(targets.filter((item) => item.id !== target.id))}
              ><Trash2 size={13} /></button>
            </div>
          </div>
        </li>;
      })}
    </ol>
    <p>序列直接生成本次分段线性 TCP 候选轨迹与节拍预算；修改后旧验证和时间轴会失效，需重新运行快速验证。</p>
  </section>;
}

function DurationField({ label, value, disabled, onChange }: {
  label: string;
  value: number;
  disabled: boolean;
  onChange: (value: number) => void;
}) {
  return <label>
    <span>{label}</span>
    <span className="robot-path-duration">
      <input
        type="number"
        min={0}
        step={.1}
        value={value}
        disabled={disabled}
        aria-label={`${label}秒数`}
        onChange={(event) => onChange(normalizeDuration(event.currentTarget.valueAsNumber))}
      />
      <small>秒</small>
    </span>
  </label>;
}

function normalizeDuration(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

function optionalDuration(
  target: RobotAssistantTargetInput,
  field: "processTimeSec" | "settleTimeSec",
  value: number,
): RobotAssistantTargetInput {
  const next = { ...target };
  if (value > 0) next[field] = value;
  else delete next[field];
  return next;
}

function format(value: number): string {
  return Number(value.toFixed(2)).toLocaleString("zh-CN");
}
