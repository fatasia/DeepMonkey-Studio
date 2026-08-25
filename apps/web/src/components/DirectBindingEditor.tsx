import { CheckCircle2, LoaderCircle, Play, RadioTower } from "lucide-react";
import { useEffect, useState } from "react";
import type { DirectBindingHttpMethod, DirectBindingSpec, DirectBindingTemplateScalar, DirectBindingTemplateValue } from "@bim-studio/contracts";
import { translate as tr, type AppLocale } from "../i18n";

export function createDefaultDirectBinding(transport: DirectBindingSpec["transport"] = "http"): DirectBindingSpec {
  const base = { version: 1 as const, gateway: "server" as const, transport, endpoint: "", access: "read-only" as const };
  return transport === "http"
    ? { ...base, transport, http: { method: "GET", refresh: { intervalMs: 5_000, immediate: true } } }
    : { ...base, transport, websocket: { reconnect: { enabled: true, initialDelayMs: 500, maxDelayMs: 30_000, multiplier: 2 } } };
}

export function DirectBindingEditor({ locale, value, disabled = false, onChange, onTest }: {
  locale: AppLocale;
  value: DirectBindingSpec;
  disabled?: boolean;
  onChange: (value: DirectBindingSpec) => void;
  onTest?: (value: DirectBindingSpec) => Promise<unknown>;
}) {
  const [paramsDraft, setParamsDraft] = useState(formatJson(value.http?.params ?? {}));
  const [bodyDraft, setBodyDraft] = useState(formatJson(value.http?.bodyTemplate ?? {}));
  const [subscribeDraft, setSubscribeDraft] = useState(formatJson(value.websocket?.subscribeMessageTemplate ?? {}));
  const [draftError, setDraftError] = useState<string>();
  const [testState, setTestState] = useState<{ status: "testing" | "ready" | "error"; message?: string }>();

  useEffect(() => {
    setParamsDraft(formatJson(value.http?.params ?? {}));
    setBodyDraft(formatJson(value.http?.bodyTemplate ?? {}));
    setSubscribeDraft(formatJson(value.websocket?.subscribeMessageTemplate ?? {}));
    setDraftError(undefined);
  }, [value.transport, value.endpoint]);

  function switchTransport(transport: DirectBindingSpec["transport"]) {
    const next = createDefaultDirectBinding(transport);
    onChange({
      ...next,
      endpoint: value.endpoint,
      ...(value.credentialRef ? { credentialRef: value.credentialRef } : {}),
      ...(value.selection ? { selection: value.selection } : {})
    });
    setTestState(undefined);
  }

  function updateSelection(patch: Partial<NonNullable<DirectBindingSpec["selection"]>>) {
    onChange(withDirectBindingSelection(value, patch));
  }

  function updateCredentialRef(credentialRef: string) {
    const next = { ...value };
    if (credentialRef) next.credentialRef = credentialRef;
    else delete next.credentialRef;
    onChange(next);
  }

  function commitJson<T>(text: string, apply: (parsed: T) => void, label: string) {
    try {
      const parsed = JSON.parse(text) as T;
      apply(parsed);
      setDraftError(undefined);
    } catch {
      setDraftError(tr(locale, `${label}不是有效 JSON`, `${label} is not valid JSON`));
    }
  }

  async function runTest() {
    setTestState({ status: "testing" });
    try {
      const result = await (onTest ? onTest(value) : import("../directBindingRuntime").then(({ testDirectBinding }) => testDirectBinding(value)));
      setTestState({ status: "ready", message: compactValue(result, locale) });
    } catch (reason) {
      setTestState({ status: "error", message: reason instanceof Error ? reason.message : tr(locale, "连接失败", "Connection failed") });
    }
  }

  return <div className="direct-binding-editor">
    <div className="dashboard-frame-grid scene-data-binding-grid">
      <label><span>{tr(locale, "接口协议", "Protocol")}</span><select disabled={disabled} value={value.transport} onChange={(event) => switchTransport(event.target.value as DirectBindingSpec["transport"])}><option value="http">HTTP(S)</option><option value="websocket">WebSocket</option></select></label>
      {value.transport === "http" && <label><span>Method</span><select disabled={disabled} value={value.http?.method ?? "GET"} onChange={(event) => onChange({ ...value, http: { ...value.http!, method: event.target.value as DirectBindingHttpMethod } })}>{(["GET", "POST", "PUT", "PATCH", "DELETE"] as DirectBindingHttpMethod[]).map((method) => <option key={method}>{method}</option>)}</select></label>}
    </div>
    <label><span>{tr(locale, "上游地址", "Upstream URL")}</span><input disabled={disabled} value={value.endpoint} onChange={(event) => onChange({ ...value, endpoint: event.target.value })} placeholder={value.transport === "http" ? "https://api.example.com/telemetry" : "wss://events.example.com/telemetry"} /></label>
    <label><span>{tr(locale, "服务端凭据引用", "Server credential reference")}</span><input disabled={disabled} value={value.credentialRef ?? ""} onChange={(event) => updateCredentialRef(event.target.value)} placeholder="plant-api-readonly" /><small>{tr(locale, "这里只保存引用，密钥由服务器解析。", "Only the reference is saved; the server resolves the secret.")}</small></label>
    <div className="dashboard-frame-grid scene-data-binding-grid">
      <label><span>JSONPath</span><input disabled={disabled} value={value.selection?.jsonPath ?? ""} onChange={(event) => updateSelection({ jsonPath: event.target.value })} placeholder="$.data.items[0]" /></label>
      <label><span>{tr(locale, "字段", "Field")}</span><input disabled={disabled} value={value.selection?.field ?? ""} onChange={(event) => updateSelection({ field: event.target.value })} placeholder="temperature" /></label>
    </div>
    {value.transport === "http" && value.http && <>
      <label><span>{tr(locale, "查询参数模板（JSON）", "Query parameter template (JSON)")}</span><textarea disabled={disabled} value={paramsDraft} onChange={(event) => setParamsDraft(event.target.value)} onBlur={() => commitJson<Record<string, DirectBindingTemplateScalar>>(paramsDraft, (params) => onChange({ ...value, http: { ...value.http!, params } }), tr(locale, "查询参数", "Query parameters"))} /></label>
      <label><span>{tr(locale, "请求体模板（JSON）", "Body template (JSON)")}</span><textarea disabled={disabled} value={bodyDraft} onChange={(event) => setBodyDraft(event.target.value)} onBlur={() => commitJson<DirectBindingTemplateValue>(bodyDraft, (bodyTemplate) => onChange({ ...value, http: { ...value.http!, bodyTemplate } }), tr(locale, "请求体", "Request body"))} /></label>
      <label><span>{tr(locale, "刷新周期（毫秒）", "Refresh interval (ms)")}</span><input disabled={disabled} type="number" min="250" value={value.http.refresh.intervalMs} onChange={(event) => onChange({ ...value, http: { ...value.http!, refresh: { ...value.http!.refresh, intervalMs: Math.max(250, Number(event.target.value)) } } })} /></label>
    </>}
    {value.transport === "websocket" && value.websocket && <>
      <label><span>Subprotocols</span><input disabled={disabled} value={(value.websocket.protocols ?? []).join(", ")} onChange={(event) => onChange({ ...value, websocket: { ...value.websocket!, protocols: event.target.value.split(",").map((item) => item.trim()).filter(Boolean) } })} placeholder="telemetry.v1" /></label>
      <label><span>{tr(locale, "订阅消息模板（JSON）", "Subscribe message template (JSON)")}</span><textarea disabled={disabled} value={subscribeDraft} onChange={(event) => setSubscribeDraft(event.target.value)} onBlur={() => commitJson<DirectBindingTemplateValue>(subscribeDraft, (subscribeMessageTemplate) => onChange({ ...value, websocket: { ...value.websocket!, subscribeMessageTemplate } }), tr(locale, "订阅消息", "Subscribe message"))} /></label>
      <div className="dashboard-frame-grid scene-data-binding-grid"><label><span>{tr(locale, "初始重连（毫秒）", "Initial reconnect (ms)")}</span><input disabled={disabled} type="number" min="0" value={value.websocket.reconnect.initialDelayMs} onChange={(event) => onChange({ ...value, websocket: { ...value.websocket!, reconnect: { ...value.websocket!.reconnect, initialDelayMs: Math.max(0, Number(event.target.value)) } } })} /></label><label><span>{tr(locale, "最大重连（毫秒）", "Maximum reconnect (ms)")}</span><input disabled={disabled} type="number" min="0" value={value.websocket.reconnect.maxDelayMs} onChange={(event) => onChange({ ...value, websocket: { ...value.websocket!, reconnect: { ...value.websocket!.reconnect, maxDelayMs: Math.max(0, Number(event.target.value)) } } })} /></label></div>
      <label><span>{tr(locale, "自动重连", "Automatic reconnect")}</span><input disabled={disabled} type="checkbox" checked={value.websocket.reconnect.enabled} onChange={(event) => onChange({ ...value, websocket: { ...value.websocket!, reconnect: { ...value.websocket!.reconnect, enabled: event.target.checked } } })} /></label>
    </>}
    {draftError && <small className="dashboard-data-binding-state error">{draftError}</small>}
    <button type="button" disabled={disabled || !value.endpoint.trim() || testState?.status === "testing"} onClick={() => void runTest()}>{testState?.status === "testing" ? <LoaderCircle className="spin" size={12} /> : testState?.status === "ready" ? <CheckCircle2 size={12} /> : value.transport === "websocket" ? <RadioTower size={12} /> : <Play size={12} />}{testState?.status === "testing" ? tr(locale, "正在测试…", "Testing…") : tr(locale, "测试连接", "Test connection")}</button>
    {testState?.message && <small className={`dashboard-data-binding-state ${testState.status}`}>{testState.message}</small>}
  </div>;
}

export function withDirectBindingSelection(value: DirectBindingSpec, patch: Partial<NonNullable<DirectBindingSpec["selection"]>>): DirectBindingSpec {
  const selection = { ...value.selection, ...patch };
  if (!selection.jsonPath?.trim()) delete selection.jsonPath;
  if (!selection.field?.trim()) delete selection.field;
  const next = { ...value };
  if (Object.keys(selection).length > 0) next.selection = selection;
  else delete next.selection;
  return next;
}

function formatJson(value: unknown): string { return JSON.stringify(value, null, 2); }
export function compactValue(value: unknown, locale: AppLocale): string {
  if (value === undefined) return tr(locale, "未匹配到值，请检查 JSONPath / 字段", "No value matched; check JSONPath / field");
  if (value === null) return "null";
  const serialized = typeof value === "string" ? value : JSON.stringify(value);
  const text = serialized ?? String(value);
  return text.length > 120 ? `${text.slice(0, 117)}…` : text;
}
