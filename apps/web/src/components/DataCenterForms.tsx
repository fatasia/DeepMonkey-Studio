import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Plus, Trash2, X } from "lucide-react";
import type { DataComputedField, DataConnectionRecord, DataConnectionType, DataDatasetRecord } from "@bim-studio/contracts";
import { compileFormula } from "@bim-studio/data-runtime";
import { api } from "../api";
import { translate as tr, type AppLocale } from "../i18n";
import { DEFAULT_DATA_REFRESH_SECONDS, MIN_DATA_REFRESH_SECONDS } from "./dataRefreshPolicy";
import { createWritebackConfigDraft, DatasetWritebackConfigFields, writebackConfigChange } from "./DatasetWritebackConfigFields";
import {
  CONNECTOR_REQUIRED,
  DATABASE_CONNECTIONS,
  JSON_QUERY_CONNECTORS,
  QUERY_CONNECTORS,
  SQL_CONNECTIONS,
  connectionLabel,
  connectionTypeOptions,
  databaseLabel,
  datasetSourceLabel,
  datasetSourcePlaceholder,
  defaultConnectorUrl,
  defaultDatasetQuery,
  defaultDatasetSourceKey,
  defaultPasswordEnv,
  defaultPort,
} from "./DataCenterPresentation";

export function ConnectionForm({
  locale,
  projectId,
  initial,
  onSaved,
  onCancel,
  onError,
}: {
  locale: AppLocale;
  projectId: string;
  initial?: DataConnectionRecord;
  onSaved: (record: DataConnectionRecord) => void;
  onCancel: () => void;
  onError: (message: string) => void;
}) {
  const [type, setType] = useState<DataConnectionType>(initial?.type ?? "http");
  const [name, setName] = useState(initial?.name ?? tr(locale, "新数据连接", "New connection"));
  const [url, setUrl] = useState(String(initial?.config.url ?? "/api/demo/sensors"));
  const [host, setHost] = useState(String(initial?.config.host ?? "127.0.0.1"));
  const [port, setPort] = useState(Number(initial?.config.port ?? defaultPort(type)));
  const [database, setDatabase] = useState(String(initial?.config.database ?? ""));
  const [serviceName, setServiceName] = useState(String(initial?.config.serviceName ?? ""));
  const [user, setUser] = useState(String(initial?.config.user ?? ""));
  const [passwordEnv, setPasswordEnv] = useState(String(initial?.config.passwordEnv ?? defaultPasswordEnv(type)));
  const [retryAttempts, setRetryAttempts] = useState(Number(initial?.config.retryAttempts ?? 0));
  const [retryDelayMs, setRetryDelayMs] = useState(Number(initial?.config.retryDelayMs ?? 250));
  const [retryMaxDelayMs, setRetryMaxDelayMs] = useState(Number(initial?.config.retryMaxDelayMs ?? 10_000));
  const [retryMultiplier, setRetryMultiplier] = useState(Number(initial?.config.retryMultiplier ?? 2));
  const [encrypt, setEncrypt] = useState(initial?.config.encrypt !== false);
  const [secure, setSecure] = useState(initial?.config.secure === true);
  const [trustServerCertificate, setTrustServerCertificate] = useState(initial?.config.trustServerCertificate === true);
  const [httpMethod, setHttpMethod] = useState(String(initial?.config.method ?? "GET"));
  const [httpAuthMode, setHttpAuthMode] = useState(String(initial?.config.authMode ?? "none"));
  const [httpHeaderName, setHttpHeaderName] = useState(String(initial?.config.headerName ?? "x-api-key"));
  const databaseConnection = DATABASE_CONNECTIONS.has(type);
  const connectorRequired = CONNECTOR_REQUIRED.has(type);

  async function save() {
    try {
      const baseConfig = databaseConnection
        ? {
            host,
            port,
            database,
            user,
            passwordEnv,
            ...(["tdengine", "clickhouse", "mongodb", "elasticsearch", "influxdb", "prometheus"].includes(type) ? { secure } : {}),
            ...(type === "oracle" ? { serviceName: serviceName || database } : {}),
            ...(type === "sqlserver" ? { encrypt, trustServerCertificate } : {}),
          }
        : {
            url,
            ...(user.trim() ? { user: user.trim() } : {}),
            ...(passwordEnv.trim() ? { passwordEnv: passwordEnv.trim() } : {}),
            ...(type === "http" ? { method: httpMethod, authMode: httpAuthMode, ...(httpAuthMode === "api-key" ? { headerName: httpHeaderName } : {}) } : {}),
          };
      const config = {
        ...baseConfig,
        retryAttempts: Math.min(10, Math.max(0, Math.round(retryAttempts) || 0)),
        retryDelayMs: Math.min(10_000, Math.max(100, Math.round(retryDelayMs) || 250)),
        retryMaxDelayMs: Math.min(60_000, Math.max(retryDelayMs, Math.round(retryMaxDelayMs) || 10_000)),
        retryMultiplier: Math.min(5, Math.max(1, retryMultiplier || 2)),
        retryJitter: 0.15,
      };
      const saved = await api.createDataConnection(projectId, { ...(initial ?? {}), name: name.trim(), type, enabled: initial?.enabled !== false, config });
      onSaved(saved);
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : String(reason));
    }
  }

  return (
    <div className="data-inline-form">
      <div className="data-form-heading">
        <strong>{initial ? tr(locale, "编辑连接", "Edit connection") : tr(locale, "新建连接", "New connection")}</strong>
        <button onClick={onCancel}>
          <X size={13} />
        </button>
      </div>
      <label>
        <span>{tr(locale, "名称", "Name")}</span>
        <input value={name} onChange={(event) => setName(event.target.value)} />
      </label>
      <label>
        <span>{tr(locale, "类型", "Type")}</span>
        <select
          value={type}
          onChange={(event) => {
            const next = event.target.value as DataConnectionType;
            setType(next);
            setPort(defaultPort(next));
            setPasswordEnv(defaultPasswordEnv(next));
            setUrl(defaultConnectorUrl(next));
          }}
        >
          {connectionTypeOptions(locale)}
        </select>
      </label>
      {connectorRequired && (
        <div className="data-connector-required">
          <AlertTriangle size={15} />
          <span>
            <strong>{tr(locale, `${connectionLabel(type)} 连接器尚未内置`, `${connectionLabel(type)} connector is not built in`)}</strong>
            <small>
              {tr(
                locale,
                "当前版本保留能力类型但不允许保存或预览，避免把配置表单误报为已支持。",
                "The type is reserved but cannot be saved or previewed, so a form is never misreported as working support.",
              )}
            </small>
          </span>
        </div>
      )}
      {databaseConnection ? (
        <>
          <div className="data-form-pair">
            <label>
              <span>Host</span>
              <input value={host} onChange={(event) => setHost(event.target.value)} />
            </label>
            <label>
              <span>Port</span>
              <input type="number" value={port} onChange={(event) => setPort(Number(event.target.value))} />
            </label>
          </div>
          <label>
            <span>{databaseLabel(type, locale)}</span>
            <input
              value={type === "oracle" ? serviceName : database}
              onChange={(event) => (type === "oracle" ? setServiceName(event.target.value) : setDatabase(event.target.value))}
            />
          </label>
          {type !== "influxdb" && (
            <label>
              <span>{tr(locale, "用户", "User")}</span>
              <input value={user} onChange={(event) => setUser(event.target.value)} />
            </label>
          )}
          <label>
            <span>{tr(locale, "密码环境变量", "Password environment")}</span>
            <input value={passwordEnv} onChange={(event) => setPasswordEnv(event.target.value)} />
            <small>{tr(locale, "密码不保存到项目，服务端从 .env 读取", "Passwords stay in .env and are not stored in projects")}</small>
          </label>
          {["tdengine", "clickhouse", "mongodb", "elasticsearch", "influxdb", "prometheus"].includes(type) && (
            <label>
              <span>{type === "mongodb" ? "MongoDB SRV / TLS" : "HTTPS"}</span>
              <input type="checkbox" checked={secure} onChange={(event) => setSecure(event.target.checked)} />
            </label>
          )}
          {type === "sqlserver" && (
            <div className="data-form-pair">
              <label>
                <span>{tr(locale, "加密连接", "Encrypt connection")}</span>
                <input type="checkbox" checked={encrypt} onChange={(event) => setEncrypt(event.target.checked)} />
              </label>
              <label>
                <span>{tr(locale, "信任自签证书", "Trust self-signed certificate")}</span>
                <input type="checkbox" checked={trustServerCertificate} onChange={(event) => setTrustServerCertificate(event.target.checked)} />
              </label>
            </div>
          )}
        </>
      ) : (
        <>
          <label>
            <span>URL / Endpoint</span>
            <input disabled={connectorRequired} value={url} onChange={(event) => setUrl(event.target.value)} placeholder={defaultConnectorUrl(type)} />
            <small>
              {tr(locale, "内置连接器会在服务端真实连接并采样；凭据不得写进 URL。", "Built-in connectors connect and sample on the server; never put credentials in the URL.")}
            </small>
          </label>
          {["mqtt", "kafka", "amqp", "opcua"].includes(type) && (
            <>
              <label>
                <span>{tr(locale, "用户（可选）", "User (optional)")}</span>
                <input value={user} onChange={(event) => setUser(event.target.value)} />
              </label>
              <label>
                <span>{tr(locale, "密码环境变量", "Password environment")}</span>
                <input value={passwordEnv} onChange={(event) => setPasswordEnv(event.target.value)} placeholder={defaultPasswordEnv(type)} />
              </label>
            </>
          )}
          {type === "snmp" && (
            <label>
              <span>{tr(locale, "Community 环境变量（v1/v2c）", "Community environment (v1/v2c)")}</span>
              <input value={passwordEnv} onChange={(event) => setPasswordEnv(event.target.value)} placeholder={defaultPasswordEnv(type)} />
            </label>
          )}
          {type === "http" && (
            <>
              <div className="data-form-pair">
                <label>
                  <span>{tr(locale, "请求方式", "Method")}</span>
                  <select value={httpMethod} onChange={(event) => setHttpMethod(event.target.value)}>
                    <option value="GET">GET</option>
                    <option value="POST">POST</option>
                  </select>
                </label>
                <label>
                  <span>{tr(locale, "鉴权方式", "Authentication")}</span>
                  <select value={httpAuthMode} onChange={(event) => setHttpAuthMode(event.target.value)}>
                    <option value="none">None</option>
                    <option value="bearer">Bearer Token</option>
                    <option value="basic">Basic</option>
                    <option value="api-key">API Key</option>
                  </select>
                </label>
              </div>
              {httpAuthMode !== "none" && (
                <>
                  {httpAuthMode === "basic" && <label><span>{tr(locale, "用户", "User")}</span><input value={user} onChange={(event) => setUser(event.target.value)} /></label>}
                  {httpAuthMode === "api-key" && <label><span>{tr(locale, "请求头名称", "Header name")}</span><input value={httpHeaderName} onChange={(event) => setHttpHeaderName(event.target.value)} /></label>}
                  <label>
                    <span>{tr(locale, "密钥环境变量", "Secret environment")}</span>
                    <input value={passwordEnv} onChange={(event) => setPasswordEnv(event.target.value)} placeholder="HTTP_API_TOKEN" />
                    <small>{tr(locale, "Token 或密码只从服务端环境变量读取。", "Tokens and passwords are read only from server environment variables.")}</small>
                  </label>
                </>
              )}
            </>
          )}
        </>
      )}
      <details className="data-form-advanced">
        <summary>{tr(locale, "高级连接策略", "Advanced connection policy")}</summary>
        <div className="data-form-pair">
          <label>
            <span>{tr(locale, "失败重试次数", "Retry attempts")}</span>
            <input type="number" min="0" max="10" step="1" value={retryAttempts} onChange={(event) => setRetryAttempts(Number(event.target.value))} />
          </label>
          <label>
            <span>{tr(locale, "初始间隔（毫秒）", "Initial delay (ms)")}</span>
            <input type="number" min="100" max="10000" step="50" value={retryDelayMs} onChange={(event) => setRetryDelayMs(Number(event.target.value))} />
          </label>
        </div>
        <div className="data-form-pair">
          <label>
            <span>{tr(locale, "最大间隔（毫秒）", "Maximum delay (ms)")}</span>
            <input type="number" min="100" max="60000" step="500" value={retryMaxDelayMs} onChange={(event) => setRetryMaxDelayMs(Number(event.target.value))} />
          </label>
          <label>
            <span>{tr(locale, "退避倍数", "Backoff multiplier")}</span>
            <input type="number" min="1" max="5" step="0.25" value={retryMultiplier} onChange={(event) => setRetryMultiplier(Number(event.target.value))} />
          </label>
        </div>
        <small>
          {tr(
            locale,
            "仅对超时、连接重置和 5xx 等瞬态错误重试；查询语法和权限错误不会重复请求。",
            "Retries only transient timeouts, resets and 5xx errors; syntax and permission errors are not repeated.",
          )}
        </small>
      </details>
      <div className="data-form-actions">
        <button onClick={onCancel}>{tr(locale, "取消", "Cancel")}</button>
        <button className="primary" disabled={!name.trim() || connectorRequired} onClick={() => void save()}>
          {connectorRequired ? tr(locale, "需安装连接器", "Connector required") : tr(locale, "保存连接", "Save")}
        </button>
      </div>
    </div>
  );
}

export function DatasetForm({
  locale,
  projectId,
  connection,
  initial,
  canConfigureWriteback = false,
  onSaved,
  onCancel,
  onError,
}: {
  locale: AppLocale;
  projectId: string;
  connection: DataConnectionRecord;
  initial?: DataDatasetRecord;
  canConfigureWriteback?: boolean;
  onSaved: (record: DataDatasetRecord) => void;
  onCancel: () => void;
  onError: (message: string) => void;
}) {
  const [name, setName] = useState(initial?.name ?? tr(locale, "新数据集", "New dataset"));
  const [query, setQuery] = useState(initial?.query ?? defaultDatasetQuery(connection.type));
  const [sourceKey, setSourceKey] = useState(initial?.sourceKey ?? defaultDatasetSourceKey(connection.type));
  const [refreshSeconds, setRefreshSeconds] = useState(initial?.refreshSeconds ?? DEFAULT_DATA_REFRESH_SECONDS);
  const [scheduledSeconds, setScheduledSeconds] = useState(initial?.refreshSeconds && initial.refreshSeconds > 0 ? initial.refreshSeconds : DEFAULT_DATA_REFRESH_SECONDS);
  const [computedFields, setComputedFields] = useState<DataComputedField[]>(initial?.computedFields ?? []);
  const [writebackDraft, setWritebackDraft] = useState(() => createWritebackConfigDraft(initial?.writeback, connection.type === "postgresql" ? "postgresql" : "http"));
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const writebackChange = useMemo(() => canConfigureWriteback && ["http", "postgresql"].includes(connection.type) ? writebackConfigChange(initial?.writeback, writebackDraft) : {}, [canConfigureWriteback, connection.type, initial?.writeback, writebackDraft]);
  const sql = SQL_CONNECTIONS.has(connection.type);
  const jsonQuery = JSON_QUERY_CONNECTORS.has(connection.type);
  const queryConnector = QUERY_CONNECTORS.has(connection.type);
  const httpQuery = connection.type === "http";
  const formulaResults = useMemo(
    () =>
      computedFields.map((field) => {
        if (field.mode === "script") return { dependencies: [] as readonly string[], error: "" };
        try {
          const compiled = compileFormula(field.formula);
          return { dependencies: compiled.dependencies, error: "" };
        } catch (reason) {
          return { dependencies: [] as readonly string[], error: reason instanceof Error ? reason.message : String(reason) };
        }
      }),
    [computedFields],
  );
  const duplicateKeys = useMemo(() => {
    const keys = computedFields.map((field) => field.key.trim()).filter(Boolean);
    return new Set(keys.filter((key, index) => keys.indexOf(key) !== index));
  }, [computedFields]);
  const invalid = computedFields.some((field, index) => !field.key.trim() || !field.formula.trim() || Boolean(formulaResults[index]?.error) || duplicateKeys.has(field.key.trim()));

  function updateComputedField(index: number, patch: Partial<DataComputedField>) {
    setComputedFields((current) => current.map((field, fieldIndex) => (fieldIndex === index ? { ...field, ...patch } : field)));
  }

  function addComputedField() {
    setComputedFields((current) => [
      ...current,
      { id: crypto.randomUUID(), key: `field_${current.length + 1}`, label: tr(locale, "计算字段", "Computed field"), type: "number", formula: "ROUND(value, 2)" },
    ]);
  }

  async function save() {
    if (savingRef.current) return;
    if (invalid || writebackChange.error) {
      if (writebackChange.error) { onError(writebackChange.error); return; }
      onError(tr(locale, "请先修正计算字段逻辑或字段名。", "Fix computed-field logic or keys before saving."));
      return;
    }
    savingRef.current = true;
    setSaving(true);
    try {
      const { writeback: _initialWriteback, ...initialFields } = initial ?? {};
      const saved = await api.createDataset(projectId, {
        ...initialFields,
        name: name.trim(),
        connectionId: connection.id,
        ...(queryConnector ? { query, ...(jsonQuery || httpQuery ? { sourceKey } : {}) } : { sourceKey }),
        refreshSeconds,
        fields: initial?.fields ?? [],
        computedFields: computedFields.map((field) => ({ ...field, key: field.key.trim(), label: field.label.trim() || field.key.trim(), formula: field.formula.trim() })),
        ...(writebackChange.writeback !== undefined ? { writeback: writebackChange.writeback } : {}),
      });
      if (mounted.current) onSaved(saved);
    } catch (reason) {
      if (mounted.current) onError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      savingRef.current = false;
      if (mounted.current) setSaving(false);
    }
  }
  return (
    <div className="data-inline-form" aria-busy={saving}>
      <fieldset className="data-dataset-form-fields" disabled={saving}>
      <div className="data-form-heading">
        <strong>{initial ? tr(locale, "编辑数据集", "Edit dataset") : tr(locale, "新建数据集", "New dataset")}</strong>
        <button onClick={onCancel}>
          <X size={13} />
        </button>
      </div>
      <label>
        <span>{tr(locale, "名称", "Name")}</span>
        <input value={name} onChange={(event) => setName(event.target.value)} />
      </label>
      {sql ? (
        <label>
          <span>SQL</span>
          <textarea value={query} onChange={(event) => setQuery(event.target.value)} />
        </label>
      ) : httpQuery ? (
        <>
          <label>
            <span>{datasetSourceLabel(connection.type, locale)}</span>
            <input value={sourceKey} onChange={(event) => setSourceKey(event.target.value)} placeholder="data.items" />
          </label>
          {String(connection.config.method || "GET").toUpperCase() === "POST" && (
            <label>
              <span>{tr(locale, "JSON 请求体", "JSON request body")}</span>
              <textarea spellCheck={false} value={query} onChange={(event) => setQuery(event.target.value)} placeholder={'{"limit":100}'} />
            </label>
          )}
        </>
      ) : jsonQuery ? (
        <>
          <label>
            <span>{datasetSourceLabel(connection.type, locale)}</span>
            <input value={sourceKey} onChange={(event) => setSourceKey(event.target.value)} placeholder={datasetSourcePlaceholder(connection.type)} />
          </label>
          <label>
            <span>{tr(locale, "只读 JSON 查询", "Read-only JSON query")}</span>
            <textarea spellCheck={false} value={query} onChange={(event) => setQuery(event.target.value)} />
          </label>
        </>
      ) : queryConnector ? (
        <label>
          <span>{connection.type === "influxdb" ? "Flux" : "PromQL"}</span>
          <textarea spellCheck={false} value={query} onChange={(event) => setQuery(event.target.value)} />
        </label>
      ) : (
        <label>
          <span>{datasetSourceLabel(connection.type, locale)}</span>
          <input value={sourceKey} onChange={(event) => setSourceKey(event.target.value)} placeholder={datasetSourcePlaceholder(connection.type)} />
        </label>
      )}
      <div className={`data-form-pair data-refresh-policy${refreshSeconds === 0 ? " manual" : ""}`}>
        <label>
          <span>{tr(locale, "更新策略", "Update policy")}</span>
          <select
            value={refreshSeconds === 0 ? "manual" : "scheduled"}
            onChange={(event) => setRefreshSeconds(event.target.value === "manual" ? 0 : scheduledSeconds)}
          >
            <option value="scheduled">{tr(locale, "定时更新", "Scheduled")}</option>
            <option value="manual">{tr(locale, "手动更新", "Manual")}</option>
          </select>
        </label>
        {refreshSeconds > 0 && (
          <label>
            <span>{tr(locale, "刷新周期（秒）", "Interval (seconds)")}</span>
            <input
              type="number"
              min={MIN_DATA_REFRESH_SECONDS}
              max="3600"
              step="1"
              value={refreshSeconds}
              onChange={(event) => {
                if (!Number.isFinite(event.currentTarget.valueAsNumber)) return;
                const seconds = Math.max(MIN_DATA_REFRESH_SECONDS, event.currentTarget.valueAsNumber);
                setScheduledSeconds(seconds);
                setRefreshSeconds(seconds);
              }}
            />
          </label>
        )}
      </div>
      <small className="data-refresh-policy-hint">
        {refreshSeconds === 0
          ? tr(locale, "打开页面时读取一次，之后仅在用户主动运行时更新。", "Loads once when opened, then updates only when run manually.")
          : tr(locale, "二维组件和拓扑会继承此周期；三维对象可在绑定中单独设置，实时连接仍采用推送。", "2D widgets and topology inherit this interval; 3D objects can override it per binding and live connections continue to use push.")}
      </small>
      {["http", "postgresql"].includes(connection.type) && canConfigureWriteback && <DatasetWritebackConfigFields locale={locale} draft={writebackDraft} disabled={saving} onChange={setWritebackDraft} />}
      {writebackChange.error && <p className="dataset-writeback-config-error" role="alert">{tr(locale, writebackChange.error, "Check the field keys, types, ranges and options.")}</p>}
      <section className="data-computed-fields">
        <header>
          <span>
            <strong>{tr(locale, "计算字段", "Computed fields")}</strong>
            <small>{tr(locale, "安全公式与隔离脚本 · 无 eval · 限时限内存", "Safe formulas and isolated scripts · no eval · time and memory limited")}</small>
          </span>
          <button type="button" onClick={addComputedField}>
            <Plus size={12} />
            {tr(locale, "添加", "Add")}
          </button>
        </header>
        {computedFields.length === 0 ? <p>{tr(locale, "按需添加派生指标，原始数据保持不变。", "Add derived metrics without changing source data.")}</p> : null}
        {computedFields.map((field, index) => {
          const result = formulaResults[index];
          const keyError = !field.key.trim()
            ? tr(locale, "字段名不能为空", "Key is required")
            : duplicateKeys.has(field.key.trim())
              ? tr(locale, "字段名不能重复", "Key must be unique")
              : "";
          return (
            <article className={keyError || result?.error ? "invalid" : ""} key={field.id}>
              <div className="data-computed-field-heading">
                <strong>{field.label || field.key || tr(locale, "未命名字段", "Untitled field")}</strong>
                <button
                  type="button"
                  title={tr(locale, "删除字段", "Delete field")}
                  onClick={() => setComputedFields((current) => current.filter((_, fieldIndex) => fieldIndex !== index))}
                >
                  <Trash2 size={12} />
                </button>
              </div>
              <div className="data-form-pair">
                <label>
                  <span>Key</span>
                  <input value={field.key} onChange={(event) => updateComputedField(index, { key: event.target.value })} />
                </label>
                <label>
                  <span>{tr(locale, "类型", "Type")}</span>
                  <select value={field.type} onChange={(event) => updateComputedField(index, { type: event.target.value as DataComputedField["type"] })}>
                    <option value="number">Number</option>
                    <option value="string">String</option>
                    <option value="boolean">Boolean</option>
                    <option value="datetime">Datetime</option>
                    <option value="json">JSON</option>
                  </select>
                </label>
              </div>
              <label>
                <span>{tr(locale, "计算方式", "Mode")}</span>
                <select
                  value={field.mode ?? "formula"}
                  onChange={(event) => {
                    const mode = event.target.value as NonNullable<DataComputedField["mode"]>;
                    updateComputedField(index, { mode, formula: mode === "script" ? "return input.value;" : "ROUND(value, 2)" });
                  }}
                >
                  <option value="formula">{tr(locale, "安全公式", "Safe formula")}</option>
                  <option value="script">JavaScript · QuickJS</option>
                </select>
              </label>
              <label>
                <span>{tr(locale, "显示名", "Label")}</span>
                <input value={field.label} onChange={(event) => updateComputedField(index, { label: event.target.value })} />
              </label>
              <label>
                <span>{field.mode === "script" ? tr(locale, "脚本", "Script") : tr(locale, "公式", "Formula")}</span>
                <textarea
                  spellCheck={false}
                  value={field.formula}
                  onChange={(event) => updateComputedField(index, { formula: event.target.value })}
                  placeholder={field.mode === "script" ? "return input.temperature * 1.8 + 32;" : 'IF(status == "alarm", temperature * 1.8 + 32, 0)'}
                />
              </label>
              {keyError || result?.error ? (
                <em>{keyError || result?.error}</em>
              ) : field.mode === "script" ? (
                <small>{tr(locale, "隔离 QuickJS · 无网络/文件/Node API · 限时限内存", "Isolated QuickJS · no network/files/Node APIs · time and memory limited")}</small>
              ) : (
                <small>
                  {result?.dependencies.length
                    ? `${tr(locale, "依赖", "Dependencies")}: ${result.dependencies.join(", ")}`
                    : tr(locale, "常量公式，无字段依赖", "Constant formula")}
                </small>
              )}
            </article>
          );
        })}
      </section>
      <div className="data-form-actions">
        <button onClick={onCancel}>{tr(locale, "取消", "Cancel")}</button>
        <button className="primary" disabled={!name.trim() || invalid || Boolean(writebackChange.error) || saving} title={writebackChange.error || (saving ? tr(locale, "正在保存", "Saving") : undefined)} onClick={() => void save()}>
          {saving ? tr(locale, "保存中…", "Saving…") : tr(locale, "保存数据集", "Save")}
        </button>
      </div>
      </fieldset>
    </div>
  );
}
