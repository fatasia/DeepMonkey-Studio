import { CheckCircle2, CircleAlert, SlidersHorizontal } from "lucide-react";
import { useEffect, useState } from "react";
import type { WorkcellScenePlanningParameters } from "./workcellAuditModel";
import "./WorkcellPlanningSetup.css";

export function WorkcellPlanningSetup({
  value,
  trajectoryCount,
  resultVisible,
  disabled,
  onChange,
}: {
  value: WorkcellScenePlanningParameters;
  trajectoryCount: number;
  resultVisible: boolean;
  disabled: boolean;
  onChange: (value: WorkcellScenePlanningParameters) => void;
}) {
  const [open, setOpen] = useState(!resultVisible);
  useEffect(() => setOpen(!resultVisible), [resultVisible]);
  const confirmed = value.status === "engineer-confirmed";

  function update(field: "clearanceThresholdMeters" | "generatedTrajectorySpeedMps" | "generatedTrajectoryTcpRadiusMeters", next: number) {
    onChange({ ...value, [field]: next, origin: "authored", status: "unconfirmed" });
  }

  return <details className="workcell-planning-setup" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary>
      <span><SlidersHorizontal size={14} /><strong>验证参数</strong><small>{confirmed ? "已确认" : value.origin === "starter-values" ? "待确认起步值" : "变更待确认"}</small></span>
      <em>{format(value.clearanceThresholdMeters)} m 间隙{trajectoryCount ? ` · ${trajectoryCount} 条候选轨迹` : ""}</em>
    </summary>
    <div className="workcell-planning-content">
      <div className={`workcell-planning-confirmation ${confirmed ? "confirmed" : "unconfirmed"}`}>
        {confirmed ? <CheckCircle2 size={15} /> : <CircleAlert size={15} />}
        <span>
          <strong>{confirmed ? "规划基准已确认" : value.origin === "starter-values" ? "系统起步值尚未确认" : "参数已变化，请重新确认"}</strong>
          <small>这些数值只用于规划快速初筛，不是机器人控制器参数或安全标准限值。</small>
        </span>
        <button
          type="button"
          disabled={disabled || confirmed}
          onClick={() => onChange({ ...value, status: "engineer-confirmed" })}
        >确认用于本次验证</button>
      </div>
      <div className="workcell-planning-fields">
        <PlanningNumber
          label="安全间隙"
          unit="m"
          value={value.clearanceThresholdMeters}
          min={0}
          max={100}
          step={.01}
          disabled={disabled}
          hint="用于必要对象、轨迹与多机器人时段的附加间隙"
          onChange={(next) => update("clearanceThresholdMeters", next)}
        />
        {trajectoryCount > 0 && <>
          <PlanningNumber
            label="候选 TCP 速度"
            unit="m/s"
            value={value.generatedTrajectorySpeedMps}
            min={.001}
            max={1_000}
            step={.01}
            disabled={disabled}
            hint="仅用于从场景目标距离推导候选时间轴"
            onChange={(next) => update("generatedTrajectorySpeedMps", next)}
          />
          <PlanningNumber
            label="TCP 包络半径"
            unit="m"
            value={value.generatedTrajectoryTcpRadiusMeters}
            min={.001}
            max={100}
            step={.01}
            disabled={disabled}
            hint="应覆盖工具、工件和定位误差，不等于真实扫掠体"
            onChange={(next) => update("generatedTrajectoryTcpRadiusMeters", next)}
          />
        </>}
      </div>
      {trajectoryCount === 0 && <p>当前场景未形成机器人直线候选轨迹；配置关节链与目标后再确认速度和 TCP 包络。</p>}
    </div>
  </details>;
}

function PlanningNumber({ label, unit, value, min, max, step, disabled, hint, onChange }: {
  label: string;
  unit: string;
  value: number;
  min: number;
  max: number;
  step: number;
  disabled: boolean;
  hint: string;
  onChange: (value: number) => void;
}) {
  return <label>
    <span>{label}<small>{hint}</small></span>
    <span className="workcell-planning-number">
      <input
        type="number"
        value={value}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        onChange={(event) => onChange(normalize(event.currentTarget.valueAsNumber, min, max))}
      />
      <em>{unit}</em>
    </span>
  </label>;
}

function normalize(value: number, minimum: number, maximum: number): number {
  return Number.isFinite(value) ? Math.min(maximum, Math.max(minimum, value)) : minimum;
}

function format(value: number): string {
  return Number(value.toFixed(3)).toLocaleString("zh-CN");
}
