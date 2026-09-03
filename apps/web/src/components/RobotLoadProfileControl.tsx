import type {
  RobotLoadCapabilityState,
  RobotToolLoadState,
  SceneRobotKinematicsState,
  Vector3Value,
} from "@bim-studio/contracts";
import { useEffect, useState } from "react";
import type { AppLocale } from "../i18n";
import { translate as tr } from "../i18n";

export function RobotLoadProfileControl({
  locale,
  robot,
  prefabCapability,
  objectOptions,
  disabled,
  onChange,
}: {
  locale: AppLocale;
  robot: SceneRobotKinematicsState;
  prefabCapability?: RobotLoadCapabilityState;
  objectOptions: Array<{ id: string; name: string }>;
  disabled: boolean;
  onChange: (robot: SceneRobotKinematicsState) => void;
}) {
  const missingCount = planningMissingCount(robot);
  const updateCapability = (field: "ratedPayloadKg" | "maximumLoadCenterDistanceMeters", value: number | undefined) => {
    const loadCapability = { ...(robot.loadCapability ?? {}), source: "author-confirmed" as const };
    if (value === undefined) delete loadCapability[field];
    else loadCapability[field] = value;
    const next = { ...robot };
    if (hasCapabilityData(loadCapability)) next.loadCapability = loadCapability;
    else delete next.loadCapability;
    onChange(next);
  };
  const updateToolScalar = (field: "toolMassKg" | "carriedPayloadKg", value: number | undefined) => {
    const toolLoad = { ...(robot.toolLoad ?? {}), source: "author-confirmed" as const };
    if (value === undefined) delete toolLoad[field];
    else toolLoad[field] = value;
    const next = { ...robot };
    if (hasToolData(toolLoad)) next.toolLoad = toolLoad;
    else delete next.toolLoad;
    onChange(next);
  };
  const updateToolVector = (field: "tcpPositionMeters" | "tcpOrientationEulerDeg" | "combinedCenterOfMassMeters", value: Vector3Value | undefined) => {
    const toolLoad = { ...(robot.toolLoad ?? {}), source: "author-confirmed" as const };
    if (value === undefined) delete toolLoad[field];
    else toolLoad[field] = value;
    const next = { ...robot };
    if (hasToolData(toolLoad)) next.toolLoad = toolLoad;
    else delete next.toolLoad;
    onChange(next);
  };
  const usePrefabPayload = () => {
    if (!prefabCapability?.ratedPayloadKg) return;
    const hasManualEnvelope = robot.loadCapability?.maximumLoadCenterDistanceMeters !== undefined;
    onChange({
      ...robot,
      loadCapability: {
        ...robot.loadCapability,
        ratedPayloadKg: prefabCapability.ratedPayloadKg,
        source: hasManualEnvelope ? "author-confirmed" : "configured-prefab",
        ...(prefabCapability.reference ? { reference: prefabCapability.reference } : {}),
      },
    });
  };

  return <details className="robot-load-profile">
    <summary>
      <span>{tr(locale, "负载与 TCP 规划参数", "Load and TCP planning")}</span>
      <em className={missingCount ? "needs-data" : "complete"}>
        {missingCount ? tr(locale, `${missingCount} 项待补`, `${missingCount} missing`) : tr(locale, "参数完整", "Complete")}
      </em>
    </summary>
    <div className="robot-load-profile-body">
      {prefabCapability?.ratedPayloadKg !== undefined && robot.loadCapability?.ratedPayloadKg !== prefabCapability.ratedPayloadKg && <div className="robot-load-prefab-hint">
        <span>{tr(locale, `资源已配置额定负载 ${prefabCapability.ratedPayloadKg} kg`, `Prefab payload ${prefabCapability.ratedPayloadKg} kg`)}</span>
        <button type="button" disabled={disabled} onClick={usePrefabPayload}>{tr(locale, "引用资源参数", "Use prefab value")}</button>
      </div>}
      <label className="robot-load-tool-binding">
        <span>{tr(locale, "末端工具对象", "Tool object")}</span>
        <select disabled={disabled} value={robot.toolObjectId ?? ""} onChange={(event) => {
          const next = { ...robot };
          if (event.target.value) next.toolObjectId = event.target.value;
          else delete next.toolObjectId;
          onChange(next);
        }}>
          <option value="">{tr(locale, "待绑定", "Not bound")}</option>
          {objectOptions.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select>
      </label>
      <div className="robot-load-number-grid">
        <OptionalNumberField disabled={disabled} label={tr(locale, "额定负载", "Rated payload")} unit="kg" min={.001} value={robot.loadCapability?.ratedPayloadKg} onChange={(value) => updateCapability("ratedPayloadKg", value)} />
        <OptionalNumberField disabled={disabled} label={tr(locale, "重心距离上限", "Load-center limit")} unit="m" min={.001} value={robot.loadCapability?.maximumLoadCenterDistanceMeters} onChange={(value) => updateCapability("maximumLoadCenterDistanceMeters", value)} />
        <OptionalNumberField disabled={disabled} label={tr(locale, "工具质量", "Tool mass")} unit="kg" min={0} value={robot.toolLoad?.toolMassKg} onChange={(value) => updateToolScalar("toolMassKg", value)} />
        <OptionalNumberField disabled={disabled} label={tr(locale, "工件质量", "Part mass")} unit="kg" min={0} value={robot.toolLoad?.carriedPayloadKg} onChange={(value) => updateToolScalar("carriedPayloadKg", value)} />
      </div>
      <OptionalVectorField disabled={disabled} label={tr(locale, "TCP 位置", "TCP position")} unit="m" value={robot.toolLoad?.tcpPositionMeters} onChange={(value) => updateToolVector("tcpPositionMeters", value)} />
      <OptionalVectorField disabled={disabled} label={tr(locale, "TCP 姿态", "TCP orientation")} unit="°" value={robot.toolLoad?.tcpOrientationEulerDeg} onChange={(value) => updateToolVector("tcpOrientationEulerDeg", value)} />
      <OptionalVectorField disabled={disabled} label={tr(locale, "工具 + 工件组合重心", "Combined center of mass")} unit="m" value={robot.toolLoad?.combinedCenterOfMassMeters} onChange={(value) => updateToolVector("combinedCenterOfMassMeters", value)} />
      <p>{tr(
        locale,
        "这里只做额定质量与组合重心距离的规划筛查；腕部力矩、惯量、加减速和厂商负载曲线仍需工程复核。",
        "Planning screen only; wrist torque, inertia, acceleration and vendor load curves still require engineering review.",
      )}</p>
    </div>
  </details>;
}

function OptionalNumberField({ disabled, label, unit, value, min, onChange }: {
  disabled: boolean;
  label: string;
  unit: string;
  value: number | undefined;
  min: number;
  onChange: (value: number | undefined) => void;
}) {
  const [draft, setDraft] = useState(value === undefined ? "" : String(value));
  useEffect(() => setDraft(value === undefined ? "" : String(value)), [value]);
  const valid = draft.trim() === "" || (Number.isFinite(Number(draft)) && Number(draft) >= min);
  const commit = () => {
    if (!draft.trim()) return onChange(undefined);
    if (valid) onChange(Number(draft));
  };
  return <label><span>{label}</span><span className="robot-load-number">
    <input
      disabled={disabled}
      type="number"
      min={min}
      step="any"
      value={draft}
      placeholder="—"
      aria-invalid={!valid}
      onChange={(event) => setDraft(event.currentTarget.value)}
      onBlur={commit}
      onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }}
    />
    <small>{unit}</small>
  </span></label>;
}

function OptionalVectorField({ disabled, label, unit, value, onChange }: {
  disabled: boolean;
  label: string;
  unit: string;
  value: Vector3Value | undefined;
  onChange: (value: Vector3Value | undefined) => void;
}) {
  const [draft, setDraft] = useState(() => vectorDraft(value));
  useEffect(() => setDraft(vectorDraft(value)), [value?.x, value?.y, value?.z]);
  const invalid = Object.values(draft).some(Boolean) && !Object.values(draft).every((item) => finiteText(item));
  const commit = () => {
    const values = [draft.x, draft.y, draft.z];
    if (values.every((item) => !item)) return onChange(undefined);
    if (!values.every((item) => finiteText(item))) return;
    onChange({ x: Number(draft.x), y: Number(draft.y), z: Number(draft.z) });
  };
  return <fieldset className="robot-load-vector" aria-invalid={invalid} onBlur={(event) => {
    if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) commit();
  }}>
    <legend>{label} <small>{unit}</small></legend>
    {(["x", "y", "z"] as const).map((axis) => <label key={axis}><span>{axis.toUpperCase()}</span><input
      disabled={disabled}
      type="number"
      step="any"
      value={draft[axis]}
      placeholder="—"
      onChange={(event) => setDraft({ ...draft, [axis]: event.currentTarget.value })}
    /></label>)}
  </fieldset>;
}

function vectorDraft(value: Vector3Value | undefined): Record<"x" | "y" | "z", string> {
  return { x: value === undefined ? "" : String(value.x), y: value === undefined ? "" : String(value.y), z: value === undefined ? "" : String(value.z) };
}

function finiteText(value: string): boolean {
  return value.trim() !== "" && Number.isFinite(Number(value));
}

function hasCapabilityData(value: RobotLoadCapabilityState): boolean {
  return value.ratedPayloadKg !== undefined || value.maximumLoadCenterDistanceMeters !== undefined;
}

function hasToolData(value: RobotToolLoadState): boolean {
  return value.toolMassKg !== undefined || value.carriedPayloadKg !== undefined || value.tcpPositionMeters !== undefined
    || value.tcpOrientationEulerDeg !== undefined || value.combinedCenterOfMassMeters !== undefined;
}

function planningMissingCount(robot: SceneRobotKinematicsState): number {
  return [
    robot.toolObjectId,
    robot.loadCapability?.ratedPayloadKg,
    robot.loadCapability?.maximumLoadCenterDistanceMeters,
    robot.loadCapability?.source,
    robot.toolLoad?.toolMassKg,
    robot.toolLoad?.carriedPayloadKg,
    robot.toolLoad?.tcpPositionMeters,
    robot.toolLoad?.tcpOrientationEulerDeg,
    robot.toolLoad?.combinedCenterOfMassMeters,
    robot.toolLoad?.source,
  ].filter((item) => item === undefined || item === "").length;
}
