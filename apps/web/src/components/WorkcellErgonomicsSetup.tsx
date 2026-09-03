import type {
  Vector3Value,
  WorkcellAnthropometryInput,
  WorkcellAuditObject,
  WorkcellErgonomicsPolicyInput,
  WorkcellErgonomicsProfile,
  WorkcellManualTaskInput,
} from "@bim-studio/contracts";
import { Plus, Ruler, Trash2, UserRound } from "lucide-react";
import { useEffect, useState } from "react";
import "./WorkcellErgonomicsSetup.css";

export function WorkcellErgonomicsSetup({
  profiles,
  operatorOptions,
  objects,
  resultVisible,
  disabled,
  onChange,
}: {
  profiles: WorkcellErgonomicsProfile[];
  operatorOptions: WorkcellAuditObject[];
  objects: WorkcellAuditObject[];
  resultVisible: boolean;
  disabled: boolean;
  onChange: (profiles: WorkcellErgonomicsProfile[]) => void;
}) {
  const [open, setOpen] = useState(!resultVisible);
  useEffect(() => setOpen(!resultVisible), [resultVisible]);
  const missing = profiles.reduce((total, profile) => total + profileMissingCount(profile, objects), 0);
  return <details className="workcell-ergonomics-setup" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary>
      <span><UserRound size={14} /><strong>人工作业规划筛查</strong><small>{profiles.length ? `${profiles.length} 个任务 · 参数与阈值均需显式提供` : "未建立作业档案 · 不会自动把设备当作人员"}</small></span>
      <em className={profiles.length && !missing ? "complete" : "needs-data"}>{profiles.length ? (missing ? `${missing} 项待补充` : "参数完整") : "未配置"}</em>
    </summary>
    <div className="workcell-ergonomics-profiles">
      <div className="workcell-ergonomics-toolbar">
        <span>{profiles.length ? "可为不同人员、工位或班次建立独立档案" : "从空白档案开始，再明确绑定场景中的人员对象"}</span>
        <button type="button" disabled={disabled} onClick={() => onChange(appendErgonomicsProfile(profiles))}><Plus size={13} />添加人工作业</button>
      </div>
      {!profiles.length && <div className="workcell-ergonomics-empty">
        <UserRound size={19} />
        <span><strong>场景中尚未确认人工作业</strong><small>添加后需要手动指定人员对象，并补充人体、任务和项目阈值；在此之前始终保持“需要数据”。</small></span>
      </div>}
      {profiles.map((profile, index) => <ErgonomicsProfileEditor
        key={profile.id}
        profile={profile}
        operatorOptions={operatorOptions}
        objects={objects}
        disabled={disabled}
        onChange={(next) => onChange(profiles.map((item, current) => current === index ? next : item))}
        onDelete={() => onChange(removeErgonomicsProfile(profiles, profile.id))}
      />)}
      <p className="workcell-ergonomics-boundary"><Ruler size={13} />百分位仅记录适用人群，不自动推断人体尺寸。结果是项目阈值的规划筛查，不是完整人体工效仿真或认证。</p>
    </div>
  </details>;
}

export function appendErgonomicsProfile(profiles: WorkcellErgonomicsProfile[]): WorkcellErgonomicsProfile[] {
  return [...profiles, createEmptyErgonomicsProfile(profiles)];
}

export function removeErgonomicsProfile(profiles: WorkcellErgonomicsProfile[], profileId: string): WorkcellErgonomicsProfile[] {
  return profiles.filter((profile) => profile.id !== profileId);
}

export function createEmptyErgonomicsProfile(profiles: WorkcellErgonomicsProfile[]): WorkcellErgonomicsProfile {
  const ids = new Set(profiles.map((profile) => profile.id));
  let index = 1;
  while (ids.has(`human-task-${index}`)) index += 1;
  return { id: `human-task-${index}`, name: `人工作业 ${index}` };
}

function ErgonomicsProfileEditor({ profile, operatorOptions, objects, disabled, onChange, onDelete }: {
  profile: WorkcellErgonomicsProfile;
  operatorOptions: WorkcellAuditObject[];
  objects: WorkcellAuditObject[];
  disabled: boolean;
  onChange: (profile: WorkcellErgonomicsProfile) => void;
  onDelete: () => void;
}) {
  const anthropometry = profile.anthropometry;
  const task = profile.task;
  const policy = profile.policy;
  const missingCount = profileMissingCount(profile, objects);
  const workPointOptions = objects.filter((item) => item.id !== profile.operatorObjectId);
  const workPointObject = task?.workPointObjectId ? objects.find((item) => item.id === task.workPointObjectId) : undefined;
  const updateAnthropometry = (patch: Partial<WorkcellAnthropometryInput>, remove: Array<keyof WorkcellAnthropometryInput> = []) => {
    const nextSection = { ...(anthropometry ?? {}), ...patch };
    remove.forEach((key) => delete nextSection[key]);
    const next = { ...profile };
    if (Object.keys(nextSection).length) next.anthropometry = nextSection;
    else delete next.anthropometry;
    onChange(next);
  };
  const updateTask = (patch: Partial<WorkcellManualTaskInput>, remove: Array<keyof WorkcellManualTaskInput> = []) => {
    const nextSection = { ...(task ?? {}), ...patch };
    remove.forEach((key) => delete nextSection[key]);
    const next = { ...profile };
    if (Object.keys(nextSection).length) next.task = nextSection;
    else delete next.task;
    onChange(next);
  };
  const updatePolicy = (patch: Partial<WorkcellErgonomicsPolicyInput>, remove: Array<keyof WorkcellErgonomicsPolicyInput> = []) => {
    const nextSection = { ...(policy ?? {}), ...patch };
    remove.forEach((key) => delete nextSection[key]);
    const next = { ...profile };
    if (Object.keys(nextSection).length) next.policy = nextSection;
    else delete next.policy;
    onChange(next);
  };
  return <article className="workcell-ergonomics-profile">
    <header>
      <span><UserRound size={13} /><strong>{profile.name}</strong></span>
      <div><em>{missingCount ? `${missingCount} 项待补` : "参数完整"}</em><button type="button" disabled={disabled} title={`删除 ${profile.name}`} aria-label={`删除 ${profile.name}`} onClick={onDelete}><Trash2 size={12} /></button></div>
    </header>
    <div className="workcell-ergonomics-bindings">
      <label><span>人员对象（手动指定）</span><select disabled={disabled} value={profile.operatorObjectId ?? ""} onChange={(event) => {
        const next = { ...profile };
        const operatorObjectId = event.currentTarget.value;
        if (operatorObjectId) {
          next.operatorObjectId = operatorObjectId;
          if (next.task?.workPointObjectId === operatorObjectId) {
            const nextTask = { ...next.task };
            delete nextTask.workPointObjectId;
            if (Object.keys(nextTask).length) next.task = nextTask;
            else delete next.task;
          }
        }
        else delete next.operatorObjectId;
        onChange(next);
      }}><option value="">待确认</option>{operatorOptions.map((item) => <option key={item.id} value={item.id}>{item.name} · {objectRoleLabel(item.role)}</option>)}</select></label>
      <label><span>场景作业点</span><select disabled={disabled} value={task?.workPointObjectId ?? ""} onChange={(event) => {
        const id = event.currentTarget.value;
        updateTask(id ? { workPointObjectId: id } : {}, id ? ["workPoint"] : ["workPointObjectId"]);
      }}><option value="">手动坐标 / 待补充</option>{workPointOptions.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
    </div>
    <section>
      <h4>1. 人体数据 <small>不内置人口统计表</small></h4>
      <div className="workcell-ergonomics-grid">
        <label><span>录入方式</span><select disabled={disabled} value={anthropometry?.method ?? ""} onChange={(event) => {
          const method = event.currentTarget.value;
          updateAnthropometry(method ? { method: method as NonNullable<WorkcellAnthropometryInput["method"]> } : {}, method === "percentile" ? [] : ["percentile", ...(method ? [] : ["method" as const])]);
        }}><option value="">待选择</option><option value="percentile">百分位样本</option><option value="explicit">明确人体参数</option></select></label>
        {anthropometry?.method === "percentile" && <OptionalNumber label="身高百分位" unit="P" min={1} max={99} value={anthropometry.percentile} disabled={disabled} onChange={(value) => updateAnthropometry(value === undefined ? {} : { percentile: value }, value === undefined ? ["percentile"] : [])} />}
        <OptionalNumber label="身高" unit="m" min={.1} max={3} value={anthropometry?.statureMeters} disabled={disabled} onChange={(value) => updateAnthropometry(value === undefined ? {} : { statureMeters: value }, value === undefined ? ["statureMeters"] : [])} />
        <OptionalNumber label="肩高" unit="m" min={.1} max={3} value={anthropometry?.shoulderHeightMeters} disabled={disabled} onChange={(value) => updateAnthropometry(value === undefined ? {} : { shoulderHeightMeters: value }, value === undefined ? ["shoulderHeightMeters"] : [])} />
        <OptionalNumber label="肘高" unit="m" min={.1} max={3} value={anthropometry?.elbowHeightMeters} disabled={disabled} onChange={(value) => updateAnthropometry(value === undefined ? {} : { elbowHeightMeters: value }, value === undefined ? ["elbowHeightMeters"] : [])} />
        <OptionalNumber label="功能可达距离" unit="m" min={.01} max={3} value={anthropometry?.functionalReachMeters} disabled={disabled} onChange={(value) => updateAnthropometry(value === undefined ? {} : { functionalReachMeters: value }, value === undefined ? ["functionalReachMeters"] : [])} />
        <label><span>人体数据来源</span><select disabled={disabled} value={anthropometry?.source ?? ""} onChange={(event) => {
          const source = event.currentTarget.value;
          updateAnthropometry(source ? { source: source as NonNullable<WorkcellAnthropometryInput["source"]> } : {}, source && source !== "author-confirmed" ? [] : source ? ["reference"] : ["source", "reference"]);
        }}><option value="">待注明</option><option value="author-confirmed">用户确认</option><option value="imported">导入数据</option><option value="reference-table">引用数据表</option></select></label>
        {anthropometry?.source && anthropometry.source !== "author-confirmed" && <TextField label="人体数据引用" value={anthropometry.reference ?? ""} disabled={disabled} onChange={(value) => updateAnthropometry(value ? { reference: value } : {}, value ? [] : ["reference"])} />}
      </div>
    </section>
    <section>
      <h4>2. 作业暴露 <small>Y 轴为高度</small></h4>
      {!task?.workPointObjectId && <OptionalVector label="作业点世界坐标" unit="m" value={task?.workPoint} disabled={disabled} onChange={(value) => updateTask(value ? { workPoint: value } : {}, value ? ["workPointObjectId"] : ["workPoint"])} />}
      {workPointObject && <p className="workcell-ergonomics-linked-point">实时采用 {workPointObject.name}：{formatPoint(workPointObject.position)}</p>}
      <div className="workcell-ergonomics-grid">
        <OptionalNumber label="单次负荷" unit="kg" min={0} max={1_000} value={task?.loadMassKg} disabled={disabled} onChange={(value) => updateTask(value === undefined ? {} : { loadMassKg: value }, value === undefined ? ["loadMassKg"] : [])} />
        <OptionalNumber label="搬运频次" unit="次/小时" min={0} max={10_000} value={task?.repetitionsPerHour} disabled={disabled} onChange={(value) => updateTask(value === undefined ? {} : { repetitionsPerHour: value }, value === undefined ? ["repetitionsPerHour"] : [])} />
        <OptionalNumber label="连续时长" unit="分钟" min={.001} max={10_080} value={task?.durationMinutes} disabled={disabled} onChange={(value) => updateTask(value === undefined ? {} : { durationMinutes: value }, value === undefined ? ["durationMinutes"] : [])} />
        <label><span>任务数据来源</span><select disabled={disabled} value={task?.source ?? ""} onChange={(event) => {
          const source = event.currentTarget.value;
          updateTask(source ? { source: source as NonNullable<WorkcellManualTaskInput["source"]> } : {}, source === "imported" ? [] : source ? ["reference"] : ["source", "reference"]);
        }}><option value="">待注明</option><option value="author-confirmed">用户确认</option><option value="imported">导入数据</option><option value="scene-geometry">场景几何 + 用户任务</option></select></label>
        {task?.source === "imported" && <TextField label="任务数据引用" value={task.reference ?? ""} disabled={disabled} onChange={(value) => updateTask(value ? { reference: value } : {}, value ? [] : ["reference"])} />}
      </div>
    </section>
    <section>
      <h4>3. 项目筛查策略 <small>显式阈值，不冒充法规限值</small></h4>
      <div className="workcell-ergonomics-grid">
        <OptionalNumber label="单次负荷上限" unit="kg" min={.001} max={1_000} value={policy?.maximumLoadKg} disabled={disabled} onChange={(value) => updatePolicy(value === undefined ? {} : { maximumLoadKg: value }, value === undefined ? ["maximumLoadKg"] : [])} />
        <OptionalNumber label="频次上限" unit="次/小时" min={.001} max={10_000} value={policy?.maximumRepetitionsPerHour} disabled={disabled} onChange={(value) => updatePolicy(value === undefined ? {} : { maximumRepetitionsPerHour: value }, value === undefined ? ["maximumRepetitionsPerHour"] : [])} />
        <OptionalNumber label="连续时长上限" unit="分钟" min={.001} max={10_080} value={policy?.maximumDurationMinutes} disabled={disabled} onChange={(value) => updatePolicy(value === undefined ? {} : { maximumDurationMinutes: value }, value === undefined ? ["maximumDurationMinutes"] : [])} />
        <OptionalNumber label="肘高容差" unit="m" min={.001} max={3} value={policy?.neutralHeightToleranceMeters} disabled={disabled} onChange={(value) => updatePolicy(value === undefined ? {} : { neutralHeightToleranceMeters: value }, value === undefined ? ["neutralHeightToleranceMeters"] : [])} />
        <OptionalNumber label="预警利用率" unit="%" min={1} max={100} value={policy?.warningUtilizationRatio === undefined ? undefined : policy.warningUtilizationRatio * 100} disabled={disabled} onChange={(value) => updatePolicy(value === undefined ? {} : { warningUtilizationRatio: value / 100 }, value === undefined ? ["warningUtilizationRatio"] : [])} />
        <label><span>策略来源</span><select disabled={disabled} value={policy?.source ?? ""} onChange={(event) => {
          const source = event.currentTarget.value;
          updatePolicy(source ? { source: source as NonNullable<WorkcellErgonomicsPolicyInput["source"]> } : {}, source && source !== "author-confirmed" ? [] : source ? ["reference"] : ["source", "reference"]);
        }}><option value="">待注明</option><option value="author-confirmed">项目确认</option><option value="imported">导入策略</option><option value="reference-table">引用规范 / 表格</option></select></label>
        {policy?.source && policy.source !== "author-confirmed" && <TextField label="策略引用" value={policy.reference ?? ""} disabled={disabled} onChange={(value) => updatePolicy(value ? { reference: value } : {}, value ? [] : ["reference"])} />}
      </div>
    </section>
  </article>;
}

function OptionalNumber({ label, unit, min, max, value, disabled, onChange }: {
  label: string; unit: string; min: number; max: number; value: number | undefined; disabled: boolean;
  onChange: (value: number | undefined) => void;
}) {
  const [draft, setDraft] = useState(value === undefined ? "" : String(value));
  useEffect(() => setDraft(value === undefined ? "" : String(value)), [value]);
  const valid = !draft.trim() || (Number.isFinite(Number(draft)) && Number(draft) >= min && Number(draft) <= max);
  const commit = () => { if (!draft.trim()) onChange(undefined); else if (valid) onChange(Number(draft)); };
  return <label><span>{label}</span><span className="workcell-ergonomics-number"><input disabled={disabled} type="number" min={min} max={max} step="any" value={draft} placeholder="—" aria-invalid={!valid} onChange={(event) => setDraft(event.currentTarget.value)} onBlur={commit} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }} /><small>{unit}</small></span></label>;
}

function OptionalVector({ label, unit, value, disabled, onChange }: {
  label: string; unit: string; value: Vector3Value | undefined; disabled: boolean;
  onChange: (value: Vector3Value | undefined) => void;
}) {
  const [draft, setDraft] = useState(() => vectorDraft(value));
  useEffect(() => setDraft(vectorDraft(value)), [value?.x, value?.y, value?.z]);
  const complete = Object.values(draft).every(finiteText);
  const invalid = Object.values(draft).some(Boolean) && !complete;
  const commit = () => {
    if (Object.values(draft).every((item) => !item)) return onChange(undefined);
    if (complete) onChange({ x: Number(draft.x), y: Number(draft.y), z: Number(draft.z) });
  };
  return <fieldset className="workcell-ergonomics-vector" aria-invalid={invalid} onBlur={(event) => {
    if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) commit();
  }}><legend>{label} <small>{unit}</small></legend>{(["x", "y", "z"] as const).map((axis) => <label key={axis}><span>{axis.toUpperCase()}</span><input disabled={disabled} type="number" step="any" value={draft[axis]} placeholder="—" onChange={(event) => setDraft({ ...draft, [axis]: event.currentTarget.value })} /></label>)}</fieldset>;
}

function TextField({ label, value, disabled, onChange }: { label: string; value: string; disabled: boolean; onChange: (value: string) => void }) {
  return <label><span>{label}</span><input disabled={disabled} type="text" maxLength={160} value={value} placeholder="文件、表格或版本号" onChange={(event) => onChange(event.currentTarget.value)} /></label>;
}

function profileMissingCount(profile: WorkcellErgonomicsProfile, objects: WorkcellAuditObject[]): number {
  const anthropometry = profile.anthropometry, task = profile.task, policy = profile.policy;
  const workPoint = task?.workPointObjectId
    ? task.workPointObjectId !== profile.operatorObjectId && objects.some((item) => item.id === task.workPointObjectId)
    : finiteVector(task?.workPoint);
  return [
    Boolean(profile.operatorObjectId && objects.some((item) => item.id === profile.operatorObjectId)),
    anthropometry?.method === "percentile" || anthropometry?.method === "explicit",
    anthropometry?.method !== "percentile" || inRange(anthropometry.percentile, 1, 99),
    positive(anthropometry?.statureMeters), positive(anthropometry?.shoulderHeightMeters), positive(anthropometry?.elbowHeightMeters), positive(anthropometry?.functionalReachMeters), Boolean(anthropometry?.source),
    !requiresReference(anthropometry?.source) || Boolean(anthropometry?.reference?.trim()),
    workPoint, nonNegative(task?.loadMassKg), nonNegative(task?.repetitionsPerHour), positive(task?.durationMinutes), Boolean(task?.source), task?.source !== "imported" || Boolean(task.reference?.trim()),
    positive(policy?.maximumLoadKg), positive(policy?.maximumRepetitionsPerHour), positive(policy?.maximumDurationMinutes), positive(policy?.neutralHeightToleranceMeters), inRange(policy?.warningUtilizationRatio, .01, 1), Boolean(policy?.source),
    !requiresReference(policy?.source) || Boolean(policy?.reference?.trim()),
  ].filter((complete) => !complete).length;
}

function vectorDraft(value: Vector3Value | undefined) { return { x: value === undefined ? "" : String(value.x), y: value === undefined ? "" : String(value.y), z: value === undefined ? "" : String(value.z) }; }
function finiteText(value: string): boolean { return value.trim() !== "" && Number.isFinite(Number(value)); }
function finiteVector(value: Vector3Value | undefined): value is Vector3Value { return Boolean(value && [value.x, value.y, value.z].every(Number.isFinite)); }
function positive(value: number | undefined): boolean { return Number.isFinite(value) && value! > 0; }
function nonNegative(value: number | undefined): boolean { return Number.isFinite(value) && value! >= 0; }
function inRange(value: number | undefined, minimum: number, maximum: number): boolean { return Number.isFinite(value) && value! >= minimum && value! <= maximum; }
function requiresReference(value: string | undefined): boolean { return value === "imported" || value === "reference-table"; }
function objectRoleLabel(value: WorkcellAuditObject["role"]): string { return ({ robot: "机器人", tool: "工具", target: "目标", equipment: "设备/对象", obstacle: "障碍物", unknown: "未分类" })[value]; }
function formatPoint(value: Vector3Value): string { return `X ${format(value.x)} · Y ${format(value.y)} · Z ${format(value.z)} m`; }
function format(value: number): string { return Number(value.toFixed(3)).toString(); }
