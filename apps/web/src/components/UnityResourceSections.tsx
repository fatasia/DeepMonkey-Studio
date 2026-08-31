import { Activity, Play } from "lucide-react";
import type { DashboardDataWidgetConfig, JsonValue, UnityReadinessIssue, UnityResourceVersionRecord } from "@bim-studio/contracts";
import { translate as tr, type AppLocale } from "../i18n";
import type { UnityRuntimeStatusDetail } from "./UnitySceneEmbed";

interface ConfigurationProps {
  locale: AppLocale;
  version: UnityResourceVersionRecord;
  widget: DashboardDataWidgetConfig;
  runtimeStatus?: Omit<UnityRuntimeStatusDetail, "widgetId">;
  onChange: (patch: Partial<DashboardDataWidgetConfig>) => void;
  onTestAction: () => void;
}

/** Unity 契约配置区只编辑已由构建清单声明的能力，避免用户手工拼写运行时协议。 */
export function UnityContractConfiguration({ locale, version, widget, runtimeStatus, onChange, onTestAction }: ConfigurationProps) {
  const manifest = version.manifest;

  function setDefaultAction(action: string) {
    if (!action) {
      const next = { ...widget };
      delete next.unityDefaultAction;
      onChange(next);
      return;
    }
    onChange({
      unityDefaultAction: {
        action,
        ...(widget.unityDefaultAction?.objectId ? { objectId: widget.unityDefaultAction.objectId } : {}),
      },
    });
  }

  function setPropertyValue(key: string, value: JsonValue) {
    onChange({ unityPropertyValues: { ...(widget.unityPropertyValues ?? {}), [key]: value } });
  }

  return (
    <>
      <section className={`unity-contract-debug ${runtimeStatus?.state ?? "idle"}`}>
        <header>
          <span>
            <Activity size={13} />
            <strong>{tr(locale, "联动调试", "Integration debug")}</strong>
          </span>
          <small>{runtimeStateText(locale, runtimeStatus?.state)}</small>
        </header>
        <div>
          <span>
            {tr(locale, "对象", "Objects")} <b>{manifest.objects?.length ?? 0}</b>
          </span>
          <span>
            {tr(locale, "动作", "Actions")} <b>{manifest.actions?.length ?? 0}</b>
          </span>
          <span>
            {tr(locale, "事件", "Events")} <b>{manifest.events?.length ?? 0}</b>
          </span>
          <span>
            {tr(locale, "数据层", "Layers")} <b>{manifest.dataLayers?.length ?? 0}</b>
          </span>
          <span>
            {tr(locale, "属性", "Properties")} <b>{manifest.properties?.length ?? 0}</b>
          </span>
        </div>
        {runtimeStatus?.state === "ready" && (runtimeStatus.latencyMs !== undefined || runtimeStatus.fps !== undefined) && (
          <p className="healthy">
            {runtimeStatus.latencyMs !== undefined ? `${runtimeStatus.latencyMs.toFixed(1)}ms ACK` : ""}
            {runtimeStatus.latencyMs !== undefined && runtimeStatus.fps !== undefined ? " · " : ""}
            {runtimeStatus.fps !== undefined ? `${runtimeStatus.fps.toFixed(0)} FPS` : ""}
            {runtimeStatus.scene ? ` · ${runtimeStatus.scene}` : ""}
          </p>
        )}
        {runtimeStatus?.message && <p>{runtimeStatus.message}</p>}
        {widget.unityDefaultAction?.action && (
          <button disabled={!runtimeStatus || !["ready", "degraded"].includes(runtimeStatus.state)} onClick={onTestAction}>
            <Play size={12} />
            {tr(locale, `测试动作：${widget.unityDefaultAction.action}`, `Test action: ${widget.unityDefaultAction.action}`)}
          </button>
        )}
      </section>

      {(manifest.scenes?.length ?? 0) > 0 && (
        <label>
          <span>{tr(locale, "当前场景", "Current scene")}</span>
          <select value={widget.unityScene ?? ""} onChange={(event) => onChange({ unityScene: event.target.value })}>
            <option value="">{tr(locale, "资源默认场景", "Build default")}</option>
            {manifest.scenes!.map((scene) => (
              <option key={scene}>{scene}</option>
            ))}
          </select>
        </label>
      )}
      {(manifest.actions?.length ?? 0) > 0 && (
        <label>
          <span>{tr(locale, "默认交互动作", "Default action")}</span>
          <select value={widget.unityDefaultAction?.action ?? ""} onChange={(event) => setDefaultAction(event.target.value)}>
            <option value="">{tr(locale, "不自动触发", "No automatic action")}</option>
            {manifest.actions!.map((action) => (
              <option key={action}>{action}</option>
            ))}
          </select>
        </label>
      )}
      {(manifest.objects?.length ?? 0) > 0 && (
        <label>
          <span>{tr(locale, "默认交互对象", "Default object")}</span>
          <select
            value={widget.unityDefaultAction?.objectId ?? ""}
            onChange={(event) =>
              onChange({
                unityDefaultAction: widget.unityDefaultAction?.action
                  ? { action: widget.unityDefaultAction.action, ...(event.target.value ? { objectId: event.target.value } : {}) }
                  : { action: "select", ...(event.target.value ? { objectId: event.target.value } : {}) },
              })
            }
          >
            <option value="">{tr(locale, "不指定对象", "No object")}</option>
            {manifest.objects!.map((object) => (
              <option key={object.id} value={object.id}>
                {object.name || object.id}
              </option>
            ))}
          </select>
        </label>
      )}

      {(manifest.properties?.length ?? 0) > 0 && (
        <div className="unity-property-list">
          <strong>{tr(locale, "Unity 属性", "Unity properties")}</strong>
          <small>
            {tr(
              locale,
              "页面修改会实时下发；脚本可用 studio.unity(组件ID).setProperty(...) 控制同一属性。",
              "Page edits are sent live; scripts control the same property through studio.unity(componentId).setProperty(...).",
            )}
          </small>
          {manifest.properties!.map((property) => {
            const value = propertyValue(widget, property.key, property.type, property.options);
            return (
              <label key={property.key}>
                <span>
                  {property.label || property.key}
                  <small>{property.target || property.type}</small>
                </span>
                {property.type === "boolean" ? (
                  <input type="checkbox" checked={value === true} onChange={(event) => setPropertyValue(property.key, event.target.checked)} />
                ) : property.type === "select" ? (
                  <select value={String(value)} onChange={(event) => setPropertyValue(property.key, event.target.value)}>
                    {(property.options ?? []).map((option) => (
                      <option key={option}>{option}</option>
                    ))}
                  </select>
                ) : (
                  <input
                    type={property.type === "number" ? "number" : property.type === "color" ? "color" : "text"}
                    value={property.type === "number" ? Number(value) : String(value)}
                    onChange={(event) => setPropertyValue(property.key, property.type === "number" ? Number(event.target.value) : event.target.value)}
                  />
                )}
              </label>
            );
          })}
        </div>
      )}

      {(manifest.dataLayers?.length ?? 0) > 0 && (
        <div className="unity-data-layer-list">
          <strong>{tr(locale, "数据层绑定", "Data layer bindings")}</strong>
          <small>
            {tr(
              locale,
              "可绑定变量、筛选参数或 data.value / data.rows；同名数据层导入后自动绑定。",
              "Bind variables, filters, or data.value / data.rows; matching layer names bind automatically.",
            )}
          </small>
          {manifest.dataLayers!.map((layer) => {
            const binding = widget.unityDataBindings?.find((item) => item.layerKey === layer.key);
            return (
              <label key={layer.key}>
                <span>
                  {layer.key}
                  <small>{[layer.description, layer.target ? `target: ${layer.target}` : "", layer.keyField ? `key: ${layer.keyField}` : ""].filter(Boolean).join(" · ")}</small>
                </span>
                <input
                  value={binding?.dataKey ?? ""}
                  placeholder="variables.device.telemetry / data.value"
                  onChange={(event) =>
                    onChange({
                      unityDataBindings: [
                        ...(widget.unityDataBindings ?? []).filter((item) => item.layerKey !== layer.key),
                        ...(event.target.value ? [{ layerKey: layer.key, dataKey: event.target.value }] : []),
                      ],
                    })
                  }
                />
              </label>
            );
          })}
        </div>
      )}
      {version.diagnostics.length > 0 && (
        <div className="unity-resource-diagnostics">
          {version.diagnostics.map((item) => (
            <small key={item}>{item}</small>
          ))}
        </div>
      )}
    </>
  );
}

interface PublicationProps {
  locale: AppLocale;
  widget: DashboardDataWidgetConfig;
  readiness: UnityReadinessIssue[];
  loading: boolean;
  onChange: (patch: Partial<DashboardDataWidgetConfig>) => void;
}

export function UnityExternalRuntimeStatus({ locale, status }: { locale: AppLocale; status?: Omit<UnityRuntimeStatusDetail, "widgetId"> }) {
  return (
    <section className={`unity-contract-debug ${status?.state ?? "idle"}`}>
      <header>
        <span>
          <Activity size={13} />
          <strong>{tr(locale, "外部运行时", "External runtime")}</strong>
        </span>
        <small>{runtimeStateText(locale, status?.state)}</small>
      </header>
      {status?.state === "ready" && (status.latencyMs !== undefined || status.fps !== undefined) && (
        <p className="healthy">
          {status.latencyMs !== undefined ? `${status.latencyMs.toFixed(1)}ms ACK` : ""}
          {status.latencyMs !== undefined && status.fps !== undefined ? " · " : ""}
          {status.fps !== undefined ? `${status.fps.toFixed(0)} FPS` : ""}
          {status.scene ? ` · ${status.scene}` : ""}
        </p>
      )}
      {status?.message && <p>{status.message}</p>}
    </section>
  );
}

export function UnityPublicationAndHosting({ locale, widget, readiness, loading, onChange }: PublicationProps) {
  const blockers = readiness.filter((item) => item.severity === "blocker").length;
  return (
    <>
      {!loading && (widget.unityResourceId || widget.unityUrl) && (
        <div className={`unity-publication-readiness ${blockers > 0 ? "blocked" : readiness.length > 0 ? "warning" : "ready"}`}>
          <header>
            <strong>{tr(locale, "发布兼容性", "Publication compatibility")}</strong>
            <small>
              {blockers > 0
                ? tr(locale, `${blockers} 项阻断`, `${blockers} blockers`)
                : readiness.length > 0
                  ? tr(locale, `${readiness.length} 项建议`, `${readiness.length} recommendations`)
                  : tr(locale, "通过", "Ready")}
            </small>
          </header>
          {readiness.length > 0 ? (
            <div>
              {readiness.map((item, index) => (
                <p className={item.severity} key={`${item.code}:${index}`}>
                  <i />
                  {locale === "zh-CN" ? item.zh : item.en}
                </p>
              ))}
            </div>
          ) : (
            <p>{tr(locale, "Unity 版本、场景、数据层、对象、动作和属性声明均可发布。", "Unity version, scenes, data layers, objects, actions, and properties are publishable.")}</p>
          )}
        </div>
      )}
      <details className="unity-resource-advanced">
        <summary>{tr(locale, "高级与外部托管", "Advanced & external hosting")}</summary>
        <label>
          <span>Manifest URL</span>
          <input
            value={widget.unityManifestUrl ?? ""}
            placeholder="https://cdn.example.com/build/manifest.json"
            onChange={(event) => onChange({ unityManifestUrl: event.target.value })}
          />
        </label>
        <label>
          <span>Unity Web URL</span>
          <input value={widget.unityUrl ?? ""} placeholder="https://cdn.example.com/unity/index.html" onChange={(event) => onChange({ unityUrl: event.target.value })} />
        </label>
        <label>
          <span>{tr(locale, "允许的消息来源", "Allowed origin")}</span>
          <input value={widget.unityAllowedOrigin ?? ""} placeholder="https://cdn.example.com" onChange={(event) => onChange({ unityAllowedOrigin: event.target.value })} />
        </label>
      </details>
    </>
  );
}

function runtimeStateText(locale: AppLocale, state?: UnityRuntimeStatusDetail["state"]): string {
  if (state === "ready") return tr(locale, "Bridge 已连接", "Bridge connected");
  if (state === "degraded") return tr(locale, "通信降级，自动重试", "Degraded; retrying");
  if (state === "error") return tr(locale, "运行异常", "Runtime error");
  if (state === "loading") return tr(locale, "正在连接", "Connecting");
  return tr(locale, "等待场景预览", "Waiting for preview");
}

function propertyValue(widget: DashboardDataWidgetConfig, key: string, type: "string" | "number" | "boolean" | "color" | "select", options?: string[]): JsonValue {
  const current = widget.unityPropertyValues?.[key];
  if (current !== undefined) return current;
  if (type === "boolean") return false;
  if (type === "number") return 0;
  return options?.[0] ?? "";
}
