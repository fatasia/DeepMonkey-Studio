import type { SceneRobotKinematicsState } from "@bim-studio/contracts";
import type { RobotWorkcellAssistantInput } from "./robotWorkcellAssistantTypes";
import { CheckCircle2, CircleAlert } from "lucide-react";
import { useEffect, useState } from "react";
import { RobotLoadProfileControl } from "./RobotLoadProfileControl";
import { RobotWorkcellPathEditor } from "./RobotWorkcellPathEditor";

export function RobotWorkcellSetup({
  input,
  resultVisible,
  onChange,
}: {
  input: RobotWorkcellAssistantInput;
  resultVisible: boolean;
  onChange: (input: RobotWorkcellAssistantInput) => void;
}) {
  const [open, setOpen] = useState(!resultVisible);
  useEffect(() => setOpen(!resultVisible), [resultVisible]);
  const planningRobot: SceneRobotKinematicsState = {
    enabled: true,
    baseBonePath: input.robot.baseBonePath,
    joints: input.robot.joints.map(({ currentAngleDeg: _angle, ...joint }) => joint),
    ...(input.robot.toolObjectId ? { toolObjectId: input.robot.toolObjectId } : {}),
    ...(input.robot.loadCapability ? { loadCapability: structuredClone(input.robot.loadCapability) } : {}),
    ...(input.robot.toolLoad ? { toolLoad: structuredClone(input.robot.toolLoad) } : {}),
  };
  const updateCycle = (field: keyof RobotWorkcellAssistantInput["cycleGoal"], value: number) => {
    onChange(markPlanningAssumptionsChanged({ ...input, cycleGoal: { ...input.cycleGoal, [field]: value } }));
  };
  const updateTargets = (targets: RobotWorkcellAssistantInput["targets"]) => {
    onChange(markPlanningAssumptionsChanged({ ...input, targets }));
  };
  const updatePlanningRobot = (next: SceneRobotKinematicsState) => {
    const robot = { ...input.robot };
    if (next.toolObjectId) robot.toolObjectId = next.toolObjectId;
    else delete robot.toolObjectId;
    if (next.loadCapability) robot.loadCapability = structuredClone(next.loadCapability);
    else delete robot.loadCapability;
    if (next.toolLoad) robot.toolLoad = structuredClone(next.toolLoad);
    else delete robot.toolLoad;
    onChange({ ...input, robot });
  };

  return (
    <details className="robot-assistant-setup" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>
        <span><strong>验证参数</strong><small>{input.taskName}</small></span>
        <em>节拍 {format(input.cycleGoal.targetSec)}s · 间隙 {input.clearanceThreshold === undefined ? "待补充" : `${format(input.clearanceThreshold)}m`}</em>
      </summary>
      <div className="robot-assistant-setup-content">
        <label className="robot-assistant-task-name">
          <span>任务名称</span>
          <input
            type="text"
            maxLength={120}
            value={input.taskName}
            aria-invalid={!input.taskName.trim()}
            onChange={(event) => onChange({ ...input, taskName: event.target.value })}
          />
        </label>
        <div className="robot-assistant-parameter-grid">
          <NumberField label="目标节拍" unit="秒" min={.1} step={.1} value={input.cycleGoal.targetSec} onChange={(value) => updateCycle("targetSec", value)} />
          <NumberField label="TCP 速度" unit="米/秒" min={.01} step={.01} value={input.cycleGoal.tcpSpeedMps ?? 0} onChange={(value) => updateCycle("tcpSpeedMps", value)} />
          <NumberField label="TCP 包络半径" unit="米" min={.001} step={.01} value={input.cycleGoal.tcpRadiusMeters ?? 0} onChange={(value) => updateCycle("tcpRadiusMeters", value)} />
          <NumberField label="关节速度" unit="度/秒" min={1} step={1} value={input.cycleGoal.jointSpeedDegPerSec ?? 90} onChange={(value) => updateCycle("jointSpeedDegPerSec", value)} />
          <NumberField label="安全间隙" unit="米" min={0} step={.01} value={input.clearanceThreshold ?? 0} onChange={(value) => onChange(markPlanningAssumptionsChanged({ ...input, clearanceThreshold: value }))} />
          <NumberField label="控制器开销" unit="秒/循环" min={0} step={.1} value={input.cycleGoal.controllerOverheadSec ?? 0} onChange={(value) => updateCycle("controllerOverheadSec", value)} />
          <NumberField label="工具动作" unit="秒/目标" min={0} step={.1} value={input.cycleGoal.toolActionSec ?? 0} onChange={(value) => updateCycle("toolActionSec", value)} />
          <NumberField label="节拍裕量" unit="%" min={0} max={200} step={1} value={input.cycleGoal.safetyMarginPercent ?? 0} onChange={(value) => updateCycle("safetyMarginPercent", value)} />
        </div>
        {input.planningAssumptions && <div className={`robot-assistant-assumption ${input.planningAssumptions.status}`}>
          {input.planningAssumptions.status === "engineer-confirmed" ? <CheckCircle2 size={14} /> : <CircleAlert size={14} />}
          <span>
            <strong>{input.planningAssumptions.status === "engineer-confirmed" ? "规划参数已确认" : input.planningAssumptions.origin === "starter-values" ? "待确认起步参数" : "参数变更待确认"}</strong>
            <small>{input.planningAssumptions.status === "engineer-confirmed"
              ? "速度、TCP 包络、动作时间、裕量与安全间隙仅用于本次规划初筛。"
              : "检查当前参数后点击“生成任务并验证”，即确认其仅用于本次规划初筛；不会下发控制器。"}</small>
          </span>
        </div>}
        <RobotLoadProfileControl
          locale="zh-CN"
          robot={planningRobot}
          objectOptions={input.objects.filter((item) => item.role === "tool").map((item) => ({ id: item.id, name: item.name }))}
          disabled={false}
          onChange={updatePlanningRobot}
        />
        <RobotWorkcellPathEditor targets={input.targets} onChange={updateTargets} />
        <p>{resultVisible ? "参数发生变化后会清除旧结果，请重新验证。" : "这些参数直接进入本次轨迹初筛与节拍预算，不会下发机器人。"}</p>
      </div>
    </details>
  );
}

function markPlanningAssumptionsChanged(input: RobotWorkcellAssistantInput): RobotWorkcellAssistantInput {
  if (!input.planningAssumptions) return input;
  return { ...input, planningAssumptions: { origin: "authored", status: "unconfirmed" } };
}

function NumberField({ label, unit, value, min, max, step, compact, onChange }: {
  label: string;
  unit: string;
  value: number;
  min: number;
  max?: number;
  step: number;
  compact?: boolean;
  onChange: (value: number) => void;
}) {
  return <label className={compact ? "compact" : ""}>
    <span>{label}</span>
    <span className="robot-assistant-number">
      <input
        type="number"
        min={min}
        {...(max === undefined ? {} : { max })}
        step={step}
        value={value}
        onChange={(event) => onChange(normalizeNumber(event.currentTarget.valueAsNumber, min, max))}
      />
      <small>{unit}</small>
    </span>
  </label>;
}

function normalizeNumber(value: number, min: number, max?: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max ?? Number.POSITIVE_INFINITY, Math.max(min, value));
}

function format(value: number): string {
  return Number(value.toFixed(2)).toLocaleString("zh-CN");
}
