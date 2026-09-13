import type { NotificationSeverity } from "./notification.js";

/** 二维、三维与拓扑共用运行语义，设备状态和告警确认是两个独立维度。 */
export type DeviceOperatingState = "unknown" | "normal" | "running" | "idle" | "warning" | "alarm" | "offline";
export interface DeviceSignalRule {
  lowAlarm?: number;
  highAlarm?: number;
  severity?: NotificationSeverity;
}
export interface DeviceSignalSnapshot {
  state: DeviceOperatingState;
  active: boolean;
  acknowledged: boolean;
  severity: NotificationSeverity;
  value?: string | number | boolean | null;
  message?: string;
  alarmId?: string;
  unit?: string;
  target?: { sceneId:string; modelId:string; layerId?:string };
}

export function assertDeviceSignalRule(value: unknown, path = "signalRule"): asserts value is DeviceSignalRule {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${path} 必须是告警规则对象`);
  const rule = value as Record<string, unknown>;
  for (const key of ["lowAlarm", "highAlarm"]) {
    if (rule[key] !== undefined && (typeof rule[key] !== "number" || !Number.isFinite(rule[key]))) throw new Error(`${path}.${key} 必须是有限数字`);
  }
  if (typeof rule.lowAlarm === "number" && typeof rule.highAlarm === "number" && rule.lowAlarm >= rule.highAlarm) throw new Error(`${path} 的低限必须小于高限`);
  if (rule.severity !== undefined && !["info", "warning", "critical"].includes(String(rule.severity))) throw new Error(`${path}.severity 无效`);
}

export function deviceOperatingState(value: unknown): DeviceOperatingState {
  if (typeof value === "boolean") return value ? "running" : "idle";
  if (value === null || value === undefined || typeof value === "number" && !Number.isFinite(value)) return "unknown";
  if (typeof value === "number") return "normal";
  if (typeof value !== "string" || !value.trim()) return "unknown";
  const normalized = value.trim().toLowerCase();
  const aliases: Readonly<Record<DeviceOperatingState, readonly string[]>> = {
    unknown:["unknown","未知"], normal:["normal","ok","正常"], running:["running","online","active","true","运行","在线"],
    idle:["idle","standby","stopped","false","空闲","待机","停止"], offline:["offline","disconnected","down","离线","断开"],
    warning:["warning","warn","异常","预警"], alarm:["alarm","critical","fault","error","告警","故障"],
  };
  for (const [state, names] of Object.entries(aliases)) if (names.includes(normalized)) return state as DeviceOperatingState;
  return Number.isFinite(Number(normalized)) ? "normal" : "unknown";
}

/** 接收标量或现场 SCADA 快照；不把非空字符串/对象一律视为健康。 */
export function resolveDeviceSignal(value: unknown, rule: DeviceSignalRule = {}): DeviceSignalSnapshot {
  assertDeviceSignalRule(rule);
  const object = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string,unknown> : undefined;
  const alarm = object?.alarm && typeof object.alarm === "object" ? object.alarm as Record<string,unknown> : object;
  const raw = object ? object.value : value;
  let state = deviceOperatingState(object?.state ?? object?.status ?? raw);
  const numeric = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() ? Number(raw) : Number.NaN;
  const exceeded = Number.isFinite(numeric) && ((rule.lowAlarm !== undefined && numeric <= rule.lowAlarm) || (rule.highAlarm !== undefined && numeric >= rule.highAlarm));
  const severityValue = alarm?.severity ?? rule.severity ?? (state === "alarm" ? "critical" : "warning");
  const severity = severityValue === "critical" || severityValue === "info" ? severityValue : "warning";
  const active = alarm?.active === true || state !== "offline" && (exceeded || alarm?.active !== false && (state === "alarm" || state === "warning"));
  if (active && state !== "offline") state = severity === "critical" || state === "alarm" ? "alarm" : "warning";
  else if (alarm?.active === false && (state === "alarm" || state === "warning")) state = "normal";
  const message = typeof alarm?.message === "string" ? alarm.message : undefined;
  const id = typeof alarm?.id === "string" ? alarm.id : typeof alarm?.alarmId === "string" ? alarm.alarmId : undefined;
  const rawTarget=object?.target && typeof object.target === "object"?object.target as Record<string,unknown>:undefined;
  const target=typeof rawTarget?.sceneId === "string" && rawTarget.sceneId.trim() && typeof rawTarget.modelId === "string" && rawTarget.modelId.trim()
    ? {sceneId:rawTarget.sceneId,modelId:rawTarget.modelId,...(typeof rawTarget.layerId === "string" && rawTarget.layerId.trim()?{layerId:rawTarget.layerId}:{})}:undefined;
  return { state, active, severity, acknowledged: active && alarm?.acknowledged === true,
    ...(raw === null || ["string","number","boolean"].includes(typeof raw) && !(typeof raw === "number" && !Number.isFinite(raw)) ? {value:raw as string|number|boolean|null} : {}),
    ...(message ? {message} : {}), ...(id ? {alarmId:id} : {}), ...(typeof object?.unit === "string" ? {unit:object.unit} : {}),
    ...(target ? {target}:{}),
  };
}
