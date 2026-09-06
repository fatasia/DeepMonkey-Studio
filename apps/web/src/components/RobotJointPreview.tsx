import { useEffect, useRef, useState } from "react";
import type { RobotJointDefinition } from "@bim-studio/contracts";
import type { AppLocale } from "../i18n";
import { translate as tr } from "../i18n";
import type { ViewerEngine } from "../viewer/ViewerEngine";
import { resolveRobotJointValues } from "../viewer/robotPoseRuntime";
import "./RobotJointPreview.css";

export function robotJointDisplay(joint: RobotJointDefinition, value: number): number { return joint.type === "prismatic" ? value : value * 180 / Math.PI; }
export function robotJointSI(joint: RobotJointDefinition, value: number): number { return joint.type === "prismatic" ? value : value * Math.PI / 180; }

export function RobotJointPreview({ locale, engine, modelId, disabled = false, disabledReason, onChange }: {
  locale: AppLocale;
  engine: Pick<ViewerEngine, "getRobotDefinition" | "getRobotPose" | "setRobotPose">;
  modelId: string;
  disabled?: boolean;
  disabledReason?: string;
  onChange: () => void;
}) {
  const definition = engine.getRobotDefinition(modelId), pose = engine.getRobotPose(modelId) ?? {};
  const initial = useRef(pose), [error, setError] = useState(""), [, revise] = useState(0);
  useEffect(() => { initial.current = engine.getRobotPose(modelId) ?? {}; setError(""); }, [engine, modelId]);
  if (!definition) return null;
  const editable = definition.joints.filter(joint => joint.type !== "fixed" && !joint.mimic);
  const passive = definition.joints.filter(joint => joint.type === "fixed" || joint.mimic);
  const resolved = resolveRobotJointValues(definition, pose);
  const unavailable = disabledReason ?? tr(locale, "当前实例不可编辑", "This instance is not editable");
  const commit = (values: Record<string, number>) => {
    if (disabled) return;
    try {
      if (engine.setRobotPose(modelId, values)) { setError(""); revise(value => value + 1); onChange(); }
    } catch (reason) { setError(reason instanceof Error ? reason.message : tr(locale, "姿态设置失败", "Could not update pose")); }
  };
  return <details className="robot-joint-preview" open>
    <summary>{tr(locale, "关节", "Joints")}</summary>
    <div className="robot-joint-preview-body">
      {editable.map(joint => {
        const value = robotJointDisplay(joint, resolved[joint.name] ?? 0), unit = joint.type === "prismatic" ? "m" : "°";
        const lower = joint.limit?.lower === undefined ? undefined : robotJointDisplay(joint, joint.limit.lower);
        const upper = joint.limit?.upper === undefined ? undefined : robotJointDisplay(joint, joint.limit.upper);
        const step = joint.type === "prismatic" ? 0.001 : 0.1;
        const label = `${joint.name} (${unit})`;
        return <div className="robot-joint-preview-row" key={joint.name}>
          <label title={`${joint.name} · ${joint.type} · ${joint.axis.x}, ${joint.axis.y}, ${joint.axis.z}`}>
            <span>{joint.name}</span><span className="robot-joint-preview-value"><input type="number" aria-label={label} disabled={disabled} title={disabled ? unavailable : label}
              {...(joint.type !== "continuous" && lower !== undefined ? { min: lower } : {})}
              {...(joint.type !== "continuous" && upper !== undefined ? { max: upper } : {})}
              step={step} value={Number(value.toFixed(joint.type === "prismatic" ? 3 : 1))}
              onChange={event => { if (event.target.value !== "" && Number.isFinite(event.target.valueAsNumber)) commit({ [joint.name]: robotJointSI(joint, event.target.valueAsNumber) }); }} />
              <small>{unit}</small></span>
          </label>
          <input type="range" aria-label={`${label} ${tr(locale, "滑杆", "slider")}`} title={disabled ? unavailable : label}
            disabled={disabled} min={joint.type === "continuous" ? Math.min(-180, value) : lower ?? Math.min(-1, value)}
            max={joint.type === "continuous" ? Math.max(180, value) : upper ?? Math.max(1, value)} step={step} value={value}
            onChange={event => commit({ [joint.name]: robotJointSI(joint, event.target.valueAsNumber) })} />
        </div>;
      })}
      {editable.length > 0 && <div className="robot-joint-preview-actions">
        <button type="button" disabled={disabled} title={disabled ? unavailable : tr(locale, "将可编辑关节归零，遵守限位", "Zero editable joints within their limits")}
          onClick={() => commit(Object.fromEntries(editable.map(joint => [joint.name, 0])))}>{tr(locale, "零位", "Zero")}</button>
        <button type="button" disabled={disabled} title={disabled ? unavailable : tr(locale, "恢复打开面板时的姿态", "Restore the pose from when this panel opened")}
          onClick={() => commit(initial.current)}>{tr(locale, "复位", "Reset")}</button>
      </div>}
      {passive.length > 0 && <details className="robot-joint-preview-passive"><summary>{tr(locale, "固定与联动", "Fixed & mimic")} ({passive.length})</summary>
        {passive.map(joint => <div key={joint.name} title={joint.mimic ? `${joint.mimic.joint} × ${joint.mimic.multiplier} + ${joint.mimic.offset}` : joint.name}>
          <span>{joint.name}</span><output>{joint.type === "fixed" ? tr(locale, "固定", "Fixed") : `${robotJointDisplay(joint, resolved[joint.name] ?? 0).toFixed(joint.type === "prismatic" ? 3 : 1)} ${joint.type === "prismatic" ? "m" : "°"}`}</output>
        </div>)}
      </details>}
      {error && <p role="alert">{error}</p>}
    </div>
  </details>;
}
