import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Activity, ArrowLeft, Bot, Braces, CheckCircle2, Database, GitBranch, Globe2, LoaderCircle, Pencil, Plus, Radio, RefreshCw, Send, ServerCog, Table2, Trash2, X } from "lucide-react";
import type { DataComputedField, DataConnectionRecord, DataConnectionType, DataDatasetPreview, DataDatasetRecord, ProjectRecord } from "@bim-studio/contracts";
import { compileFormula } from "@bim-studio/data-runtime";
import { api } from "../api";
import { translate as tr, type AppLocale } from "../i18n";
import { DataPipelineStudio } from "./DataPipelineStudio";
import { DataEndpointStudio } from "./DataEndpointStudio";

const SQL_CONNECTIONS = new Set<DataConnectionType>(["postgresql", "mysql", "oracle", "tdengine"]);

export function DataCenter({ locale, project, onBack }: { locale: AppLocale; project: ProjectRecord; onBack: () => void }) {
  const [connections, setConnections] = useState<DataConnectionRecord[]>([]);
  const [datasets, setDatasets] = useState<DataDatasetRecord[]>([]);
  const [selectedConnectionId, setSelectedConnectionId] = useState<string>();
  const [selectedDatasetId, setSelectedDatasetId] = useState<string>();
  const [preview, setPreview] = useState<DataDatasetPreview>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [connectionEditor, setConnectionEditor] = useState<DataConnectionRecord | "new">();
  const [datasetEditor, setDatasetEditor] = useState<DataDatasetRecord | "new">();
  const [sqlAssistantOpen, setSqlAssistantOpen] = useState(false);
  const [sqlQuestion, setSqlQuestion] = useState("");
  const [sqlAnswer, setSqlAnswer] = useState("");
  const [sqlBusy, setSqlBusy] = useState(false);
  const [section, setSection] = useState<"data" | "pipeline" | "endpoint">("data");

  async function load(preferredConnectionId?: string, preferredDatasetId?: string) {
    setBusy(true);
    try {
      const [nextConnections, nextDatasets] = await Promise.all([api.listDataConnections(project.id), api.listDatasets(project.id)]);
      setConnections(nextConnections);
      setDatasets(nextDatasets);
      const connectionId = preferredConnectionId ?? selectedConnectionId;
      const nextConnectionId = nextConnections.some((item) => item.id === connectionId) ? connectionId : nextConnections[0]?.id;
      setSelectedConnectionId(nextConnectionId);
      const datasetId = preferredDatasetId ?? selectedDatasetId;
      setSelectedDatasetId(nextDatasets.some((item) => item.id === datasetId && (!nextConnectionId || item.connectionId === nextConnectionId)) ? datasetId : nextDatasets.find((item) => item.connectionId === nextConnectionId)?.id);
      setError(undefined);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => { void load(); }, [project.id]);
  const selectedDataset = datasets.find((item) => item.id === selectedDatasetId);
  const selectedConnection = connections.find((item) => item.id === selectedConnectionId);
  const connectionDatasets = useMemo(() => datasets.filter((item) => !selectedConnectionId || item.connectionId === selectedConnectionId), [datasets, selectedConnectionId]);

  async function inspect(datasetId = selectedDatasetId) {
    if (!datasetId) return;
    setBusy(true);
    try { setPreview(await api.previewDataset(project.id, datasetId)); setSelectedDatasetId(datasetId); setError(undefined); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  }

  async function deleteConnection(connection: DataConnectionRecord) {
    if (!window.confirm(tr(locale, `删除连接“${connection.name}”及其数据集？`, `Delete “${connection.name}” and its datasets?`))) return;
    try { await api.deleteDataConnection(project.id, connection.id); setPreview(undefined); await load(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  }

  async function deleteDataset(dataset: DataDatasetRecord) {
    if (!window.confirm(tr(locale, `删除数据集“${dataset.name}”？`, `Delete dataset “${dataset.name}”?`))) return;
    try { await api.deleteDataset(project.id, dataset.id); setPreview(undefined); await load(selectedConnectionId); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  }

  async function askSqlAssistant() {
    if (!sqlQuestion.trim() || !selectedConnection) return;
    setSqlBusy(true); setSqlAnswer(""); setError(undefined);
    try {
      const result = await api.streamAssistant("sql", sqlQuestion.trim(), {
        connection: { name: selectedConnection.name, type: selectedConnection.type },
        dataset: selectedDataset ? { name: selectedDataset.name, query: selectedDataset.query, fields: selectedDataset.fields } : undefined
      }, (delta) => setSqlAnswer((current) => current + delta));
      setSqlAnswer(result.text);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setSqlBusy(false); }
  }

  async function applyGeneratedSql() {
    if (!selectedDataset || !selectedConnection) return;
    const sql = extractReadOnlySql(sqlAnswer);
    if (!sql) { setError(tr(locale, "未识别到安全的只读 SQL，请让助手只返回 SELECT、WITH 或 EXPLAIN 查询。", "No safe read-only SQL found. Ask for a SELECT, WITH or EXPLAIN query.")); return; }
    try {
      const saved = await api.createDataset(project.id, { ...selectedDataset, query: sql });
      setSqlAssistantOpen(false); setSqlQuestion(""); setSqlAnswer("");
      await load(selectedConnection.id, saved.id);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  }

  return <main className="data-center-page">
    <header className="data-center-header secondary-page-header"><button className="data-back secondary-page-back" onClick={onBack}><ArrowLeft size={17} />{tr(locale, "返回场景管理", "Back to scenes")}</button><div className="secondary-page-heading-row"><div className="data-center-title secondary-page-title"><small>PROJECT DATA HUB</small><h1>{tr(locale, "数据中心", "Data center")}</h1><p>{project.name} · {tr(locale, "连接、查询、预览，然后在 Studio 里直接绑定", "Connect, query, preview, then bind directly in Studio")}</p></div></div></header>
    <section className="data-center-flow"><FlowStep icon={<Database />} index="1" title={tr(locale, "数据连接", "Connections")} caption={tr(locale, "数据库、接口、实时协议", "Databases, APIs and live protocols")} /><i /><FlowStep icon={<Table2 />} index="2" title={tr(locale, "数据集", "Datasets")} caption={tr(locale, "查询、字段和刷新策略", "Queries, fields and refresh")} /><i /><FlowStep icon={<Activity />} index="3" title={tr(locale, "场景绑定", "Scene binding")} caption={tr(locale, "进入 Studio 选择数据集", "Select a dataset in Studio")} /></section>
    {error && <div className="data-center-error"><span>{error}</span><button onClick={() => setError(undefined)}><X size={14} /></button></div>}
    <nav className="data-hub-tabs"><button className={section === "data" ? "active" : ""} onClick={() => setSection("data")}><Database size={14} /><span><strong>{tr(locale, "数据准备", "Data preparation")}</strong><small>{tr(locale, "连接、查询、字段", "Connections, queries, fields")}</small></span></button><button className={section === "pipeline" ? "active" : ""} onClick={() => setSection("pipeline")}><GitBranch size={14} /><span><strong>{tr(locale, "逻辑编排", "Logic pipeline")}</strong><small>{tr(locale, "节点、脚本、逐步诊断", "Nodes, scripts, diagnostics")}</small></span></button><button className={section === "endpoint" ? "active" : ""} onClick={() => setSection("endpoint")}><ServerCog size={14} /><span><strong>{tr(locale, "接口服务", "Endpoint services")}</strong><small>REST / WebSocket · API Key</small></span></button></nav>
    {section === "pipeline" ? <DataPipelineStudio locale={locale} projectId={project.id} datasets={datasets} onError={(message) => setError(message || undefined)} /> : section === "endpoint" ? <DataEndpointStudio locale={locale} projectId={project.id} onError={(message) => setError(message || undefined)} /> : <div className="data-center-columns">
      <section className="data-center-pane"><header><div><strong>{tr(locale, "数据连接", "Connections")}</strong><span>{connections.length} {tr(locale, "个连接", "connections")}</span></div><button onClick={() => setConnectionEditor("new")}><Plus size={14} />{tr(locale, "新建", "New")}</button></header>
        {connectionEditor && <ConnectionForm locale={locale} projectId={project.id} {...(connectionEditor === "new" ? {} : { initial: connectionEditor })} onCancel={() => setConnectionEditor(undefined)} onError={setError} onSaved={(saved) => { setConnectionEditor(undefined); void load(saved.id); }} />}
        <div className="data-card-list">{connections.map((connection) => <article key={connection.id} className={`data-resource-card ${selectedConnectionId === connection.id ? "active" : ""}`}><button className="data-card-main" onClick={() => { setSelectedConnectionId(connection.id); setSelectedDatasetId(datasets.find((item) => item.connectionId === connection.id)?.id); setPreview(undefined); }}><ConnectionIcon type={connection.type} /><span><strong>{connection.name}</strong><small>{connectionLabel(connection.type)} · {connectionSummary(connection)}</small></span><i className={connection.enabled ? "online" : ""} /></button><div className="data-card-actions"><button title={tr(locale, "重命名或编辑", "Rename or edit")} onClick={() => setConnectionEditor(connection)}><Pencil size={13} /></button><button className="danger" title={tr(locale, "删除", "Delete")} onClick={() => void deleteConnection(connection)}><Trash2 size={13} /></button></div></article>)}</div>
      </section>
      <section className="data-center-pane"><header><div><strong>{tr(locale, "数据集", "Datasets")}</strong><span>{connectionDatasets.length} {tr(locale, "个数据集", "datasets")}</span></div><button disabled={!selectedConnection} onClick={() => setDatasetEditor("new")}><Plus size={14} />{tr(locale, "新建", "New")}</button></header>
        {datasetEditor && selectedConnection && <DatasetForm locale={locale} projectId={project.id} connection={selectedConnection} {...(datasetEditor === "new" ? {} : { initial: datasetEditor })} onCancel={() => setDatasetEditor(undefined)} onError={setError} onSaved={(saved) => { setDatasetEditor(undefined); void load(selectedConnection.id, saved.id); }} />}
        <div className="data-card-list">{connectionDatasets.map((dataset) => <article key={dataset.id} className={`data-resource-card ${selectedDatasetId === dataset.id ? "active" : ""}`}><button className="data-card-main" onClick={() => void inspect(dataset.id)}><Table2 size={17} /><span><strong>{dataset.name}</strong><small>{dataset.fields.length + (dataset.computedFields?.length ?? 0)} {tr(locale, "个字段", "fields")} · {dataset.refreshSeconds ? `${dataset.refreshSeconds}s` : tr(locale, "手动", "Manual")}</small></span><Braces size={14} /></button><div className="data-card-actions"><button title={tr(locale, "重命名或编辑", "Rename or edit")} onClick={() => setDatasetEditor(dataset)}><Pencil size={13} /></button><button className="danger" title={tr(locale, "删除", "Delete")} onClick={() => void deleteDataset(dataset)}><Trash2 size={13} /></button></div></article>)}</div>
      </section>
      <section className="data-center-preview"><header><div><strong>{selectedDataset?.name ?? tr(locale, "数据预览", "Data preview")}</strong><span>{preview ? `${preview.rows.length} ${tr(locale, "行", "rows")} · ${preview.durationMs.toFixed(0)}ms` : tr(locale, "选择数据集并运行", "Select a dataset and run it")}</span></div><div className="data-preview-actions"><button disabled={!selectedConnection || !SQL_CONNECTIONS.has(selectedConnection.type)} className={sqlAssistantOpen ? "active" : ""} onClick={() => setSqlAssistantOpen((value) => !value)}><Bot size={14} />SQL {tr(locale, "助手", "Assistant")}</button><button disabled={!selectedDataset || busy} onClick={() => void inspect()}>{busy ? <LoaderCircle className="spin" size={14} /> : <RefreshCw size={14} />}{tr(locale, "运行查询", "Run query")}</button></div></header><div className="data-preview-content">{sqlAssistantOpen && <section className="data-sql-assistant"><header><div><Bot size={16} /><span><strong>SQL {tr(locale, "助手", "Assistant")}</strong><small>{selectedConnection ? `${connectionLabel(selectedConnection.type)} · ${selectedDataset?.name ?? tr(locale, "新查询", "New query")}` : tr(locale, "请选择数据库连接", "Select a database connection")}</small></span></div><button onClick={() => setSqlAssistantOpen(false)}><X size={13} /></button></header><div className="data-sql-prompt"><textarea value={sqlQuestion} onChange={(event) => setSqlQuestion(event.target.value)} placeholder={tr(locale, "例如：按小时统计最近 7 天的平均温度，并解释索引建议", "For example: hourly average temperature over 7 days with index advice")} /><button disabled={sqlBusy || !sqlQuestion.trim()} onClick={() => void askSqlAssistant()}>{sqlBusy ? <LoaderCircle className="spin" size={14} /> : <Send size={14} />}{tr(locale, "生成", "Generate")}</button></div>{sqlAnswer ? <><pre>{sqlAnswer}</pre><footer><span>{tr(locale, "写入前会校验为只读查询", "Validated as read-only before applying")}</span><button disabled={!selectedDataset || sqlBusy} onClick={() => void applyGeneratedSql()}>{tr(locale, "写入当前数据集", "Apply to dataset")}</button></footer></> : <div className="data-sql-empty">{tr(locale, "可生成、解释或优化 SQL；助手会读取当前数据集字段和已有查询。", "Generate, explain or optimize SQL using the current dataset schema and query.")}</div>}</section>}<DatasetPreview locale={locale} {...(preview ? { preview } : {})} /></div>
        {selectedDataset && <footer><div><CheckCircle2 size={15} /><span><strong>{tr(locale, "可用于 Studio", "Ready for Studio")}</strong><small>{tr(locale, "数据看板中选择此数据集和字段即可生成组件。", "Select this dataset and a field in the dashboard.")}</small></span></div></footer>}
      </section>
    </div>}
  </main>;
}

function ConnectionForm({ locale, projectId, initial, onSaved, onCancel, onError }: { locale: AppLocale; projectId: string; initial?: DataConnectionRecord; onSaved: (record: DataConnectionRecord) => void; onCancel: () => void; onError: (message: string) => void }) {
  const [type, setType] = useState<DataConnectionType>(initial?.type ?? "http");
  const [name, setName] = useState(initial?.name ?? tr(locale, "新数据连接", "New connection"));
  const [url, setUrl] = useState(String(initial?.config.url ?? "/api/demo/sensors"));
  const [host, setHost] = useState(String(initial?.config.host ?? "127.0.0.1"));
  const [port, setPort] = useState(Number(initial?.config.port ?? defaultPort(type)));
  const [database, setDatabase] = useState(String(initial?.config.database ?? ""));
  const [serviceName, setServiceName] = useState(String(initial?.config.serviceName ?? ""));
  const [user, setUser] = useState(String(initial?.config.user ?? ""));
  const [passwordEnv, setPasswordEnv] = useState(String(initial?.config.passwordEnv ?? defaultPasswordEnv(type)));
  const sql = SQL_CONNECTIONS.has(type);

  async function save() {
    try {
      const config = sql ? { host, port, database, user, passwordEnv, ...(type === "oracle" ? { serviceName: serviceName || database } : {}) } : { url };
      const saved = await api.createDataConnection(projectId, { ...(initial ?? {}), name: name.trim(), type, enabled: initial?.enabled !== false, config });
      onSaved(saved);
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : String(reason));
    }
  }

  return <div className="data-inline-form"><div className="data-form-heading"><strong>{initial ? tr(locale, "编辑连接", "Edit connection") : tr(locale, "新建连接", "New connection")}</strong><button onClick={onCancel}><X size={13} /></button></div><label><span>{tr(locale, "名称", "Name")}</span><input value={name} onChange={(event) => setName(event.target.value)} /></label><label><span>{tr(locale, "类型", "Type")}</span><select value={type} onChange={(event) => { const next = event.target.value as DataConnectionType; setType(next); setPort(defaultPort(next)); setPasswordEnv(defaultPasswordEnv(next)); }}>{connectionTypeOptions()}</select></label>{sql ? <><div className="data-form-pair"><label><span>Host</span><input value={host} onChange={(event) => setHost(event.target.value)} /></label><label><span>Port</span><input type="number" value={port} onChange={(event) => setPort(Number(event.target.value))} /></label></div><label><span>{type === "oracle" ? "Service / SID" : tr(locale, "数据库", "Database")}</span><input value={type === "oracle" ? serviceName : database} onChange={(event) => type === "oracle" ? setServiceName(event.target.value) : setDatabase(event.target.value)} /></label><label><span>{tr(locale, "用户", "User")}</span><input value={user} onChange={(event) => setUser(event.target.value)} /></label><label><span>{tr(locale, "密码环境变量", "Password environment")}</span><input value={passwordEnv} onChange={(event) => setPasswordEnv(event.target.value)} /><small>{tr(locale, "密码不保存到项目，服务端从 .env 读取", "Passwords stay in .env and are not stored in projects")}</small></label></> : <label><span>URL / Endpoint</span><input value={url} onChange={(event) => setUrl(event.target.value)} placeholder={type === "http" ? "https://api.example.com/data" : `${type}://...`} /><small>{tr(locale, "实时与工业协议通过内置连接器或按需插件接入。", "Live and industrial protocols use built-in connectors or optional plugins.")}</small></label>}<div className="data-form-actions"><button onClick={onCancel}>{tr(locale, "取消", "Cancel")}</button><button className="primary" disabled={!name.trim()} onClick={() => void save()}>{tr(locale, "保存连接", "Save")}</button></div></div>;
}

function DatasetForm({ locale, projectId, connection, initial, onSaved, onCancel, onError }: { locale: AppLocale; projectId: string; connection: DataConnectionRecord; initial?: DataDatasetRecord; onSaved: (record: DataDatasetRecord) => void; onCancel: () => void; onError: (message: string) => void }) {
  const [name, setName] = useState(initial?.name ?? tr(locale, "新数据集", "New dataset"));
  const [query, setQuery] = useState(initial?.query ?? "SELECT * FROM your_table LIMIT 100");
  const [sourceKey, setSourceKey] = useState(initial?.sourceKey ?? "items");
  const [refreshSeconds, setRefreshSeconds] = useState(initial?.refreshSeconds ?? 5);
  const [computedFields, setComputedFields] = useState<DataComputedField[]>(initial?.computedFields ?? []);
  const sql = SQL_CONNECTIONS.has(connection.type);
  const formulaResults = useMemo(() => computedFields.map((field) => {
    if (field.mode === "script") return { dependencies: [] as readonly string[], error: "" };
    try {
      const compiled = compileFormula(field.formula);
      return { dependencies: compiled.dependencies, error: "" };
    } catch (reason) {
      return { dependencies: [] as readonly string[], error: reason instanceof Error ? reason.message : String(reason) };
    }
  }), [computedFields]);
  const duplicateKeys = useMemo(() => {
    const keys = computedFields.map((field) => field.key.trim()).filter(Boolean);
    return new Set(keys.filter((key, index) => keys.indexOf(key) !== index));
  }, [computedFields]);
  const invalid = computedFields.some((field, index) => !field.key.trim() || !field.formula.trim() || Boolean(formulaResults[index]?.error) || duplicateKeys.has(field.key.trim()));

  function updateComputedField(index: number, patch: Partial<DataComputedField>) {
    setComputedFields((current) => current.map((field, fieldIndex) => fieldIndex === index ? { ...field, ...patch } : field));
  }

  function addComputedField() {
    setComputedFields((current) => [...current, { id: crypto.randomUUID(), key: `field_${current.length + 1}`, label: tr(locale, "计算字段", "Computed field"), type: "number", formula: "ROUND(value, 2)" }]);
  }

  async function save() {
    if (invalid) {
      onError(tr(locale, "请先修正计算字段逻辑或字段名。", "Fix computed-field logic or keys before saving."));
      return;
    }
    try {
      const saved = await api.createDataset(projectId, { ...(initial ?? {}), name: name.trim(), connectionId: connection.id, ...(sql ? { query } : { sourceKey }), refreshSeconds, fields: initial?.fields ?? [], computedFields: computedFields.map((field) => ({ ...field, key: field.key.trim(), label: field.label.trim() || field.key.trim(), formula: field.formula.trim() })) });
      onSaved(saved);
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : String(reason));
    }
  }
  return <div className="data-inline-form">
    <div className="data-form-heading"><strong>{initial ? tr(locale, "编辑数据集", "Edit dataset") : tr(locale, "新建数据集", "New dataset")}</strong><button onClick={onCancel}><X size={13} /></button></div>
    <label><span>{tr(locale, "名称", "Name")}</span><input value={name} onChange={(event) => setName(event.target.value)} /></label>
    {sql ? <label><span>SQL</span><textarea value={query} onChange={(event) => setQuery(event.target.value)} /></label> : <label><span>{tr(locale, "数据路径", "Data path")}</span><input value={sourceKey} onChange={(event) => setSourceKey(event.target.value)} placeholder="items" /></label>}
    <label><span>{tr(locale, "刷新秒数", "Refresh seconds")}</span><input type="number" min="0" value={refreshSeconds} onChange={(event) => setRefreshSeconds(Math.max(0, Number(event.target.value)))} /></label>
    <section className="data-computed-fields">
      <header><span><strong>{tr(locale, "计算字段", "Computed fields")}</strong><small>{tr(locale, "安全公式与隔离脚本 · 无 eval · 限时限内存", "Safe formulas and isolated scripts · no eval · time and memory limited")}</small></span><button type="button" onClick={addComputedField}><Plus size={12} />{tr(locale, "添加", "Add")}</button></header>
      {computedFields.length === 0 ? <p>{tr(locale, "按需添加派生指标，原始数据保持不变。", "Add derived metrics without changing source data.")}</p> : null}
      {computedFields.map((field, index) => {
        const result = formulaResults[index];
        const keyError = !field.key.trim() ? tr(locale, "字段名不能为空", "Key is required") : duplicateKeys.has(field.key.trim()) ? tr(locale, "字段名不能重复", "Key must be unique") : "";
        return <article className={keyError || result?.error ? "invalid" : ""} key={field.id}>
          <div className="data-computed-field-heading"><strong>{field.label || field.key || tr(locale, "未命名字段", "Untitled field")}</strong><button type="button" title={tr(locale, "删除字段", "Delete field")} onClick={() => setComputedFields((current) => current.filter((_, fieldIndex) => fieldIndex !== index))}><Trash2 size={12} /></button></div>
          <div className="data-form-pair"><label><span>Key</span><input value={field.key} onChange={(event) => updateComputedField(index, { key: event.target.value })} /></label><label><span>{tr(locale, "类型", "Type")}</span><select value={field.type} onChange={(event) => updateComputedField(index, { type: event.target.value as DataComputedField["type"] })}><option value="number">Number</option><option value="string">String</option><option value="boolean">Boolean</option><option value="datetime">Datetime</option><option value="json">JSON</option></select></label></div>
          <label><span>{tr(locale, "计算方式", "Mode")}</span><select value={field.mode ?? "formula"} onChange={(event) => { const mode = event.target.value as NonNullable<DataComputedField["mode"]>; updateComputedField(index, { mode, formula: mode === "script" ? "return input.value;" : "ROUND(value, 2)" }); }}><option value="formula">{tr(locale, "安全公式", "Safe formula")}</option><option value="script">JavaScript · QuickJS</option></select></label>
          <label><span>{tr(locale, "显示名", "Label")}</span><input value={field.label} onChange={(event) => updateComputedField(index, { label: event.target.value })} /></label>
          <label><span>{field.mode === "script" ? tr(locale, "脚本", "Script") : tr(locale, "公式", "Formula")}</span><textarea spellCheck={false} value={field.formula} onChange={(event) => updateComputedField(index, { formula: event.target.value })} placeholder={field.mode === "script" ? "return input.temperature * 1.8 + 32;" : 'IF(status == "alarm", temperature * 1.8 + 32, 0)'} /></label>
          {keyError || result?.error ? <em>{keyError || result?.error}</em> : field.mode === "script" ? <small>{tr(locale, "隔离 QuickJS · 无网络/文件/Node API · 限时限内存", "Isolated QuickJS · no network/files/Node APIs · time and memory limited")}</small> : <small>{result?.dependencies.length ? `${tr(locale, "依赖", "Dependencies")}: ${result.dependencies.join(", ")}` : tr(locale, "常量公式，无字段依赖", "Constant formula")}</small>}
        </article>;
      })}
    </section>
    <div className="data-form-actions"><button onClick={onCancel}>{tr(locale, "取消", "Cancel")}</button><button className="primary" disabled={!name.trim() || invalid} onClick={() => void save()}>{tr(locale, "保存数据集", "Save")}</button></div>
  </div>;
}

function DatasetPreview({ locale, preview }: { locale: AppLocale; preview?: DataDatasetPreview }) {
  if (!preview) return <div className="data-preview-empty"><Table2 size={30} /><strong>{tr(locale, "选择一个数据集", "Select a dataset")}</strong><span>{tr(locale, "运行查询后自动识别字段，并展示前 100 行数据。", "Run the query to infer fields and preview up to 100 rows.")}</span></div>;
  return <div className="data-preview-table"><table><thead><tr>{preview.fields.map((field) => <th key={field.key}><span>{field.label}</span><small>{field.type}{field.unit ? ` · ${field.unit}` : ""}</small></th>)}</tr></thead><tbody>{preview.rows.slice(0, 20).map((row, index) => <tr key={index}>{preview.fields.map((field) => <td key={field.key}>{formatCell(row[field.key])}</td>)}</tr>)}</tbody></table></div>;
}

function FlowStep({ icon, index, title, caption }: { icon: ReactNode; index: string; title: string; caption: string }) { return <div><b>{index}</b>{icon}<span><strong>{title}</strong><small>{caption}</small></span></div>; }
function ConnectionIcon({ type }: { type: DataConnectionType }) { return type === "http" ? <Globe2 size={18} /> : SQL_CONNECTIONS.has(type) ? <Database size={18} /> : <Radio size={18} />; }
function connectionLabel(type: DataConnectionType) { return ({ postgresql: "PostgreSQL", mysql: "MySQL", oracle: "Oracle", tdengine: "TDengine", http: "HTTP API", websocket: "WebSocket", mqtt: "MQTT", opcua: "OPC UA", modbus: "Modbus TCP", bacnet: "BACnet", tcp: "TCP", udp: "UDP", serial: "Serial", s7: "Siemens S7", "ethernet-ip": "EtherNet/IP", snmp: "SNMP", amqp: "AMQP", kafka: "Kafka", coap: "CoAP" } as Record<DataConnectionType, string>)[type]; }
function connectionSummary(connection: DataConnectionRecord) { return String(connection.config.url || connection.config.database || connection.config.serviceName || connection.config.host || "实时连接"); }
function formatCell(value: unknown) { if (value === null || value === undefined) return "—"; if (typeof value === "object") return JSON.stringify(value); return String(value); }
function defaultPort(type: DataConnectionType) { return ({ postgresql: 5432, mysql: 3306, oracle: 1521, tdengine: 6041 } as Partial<Record<DataConnectionType, number>>)[type] ?? 0; }
function defaultPasswordEnv(type: DataConnectionType) { return ({ postgresql: "POSTGRES_PASSWORD", mysql: "MYSQL_PASSWORD", oracle: "ORACLE_PASSWORD", tdengine: "TDENGINE_PASSWORD" } as Partial<Record<DataConnectionType, string>>)[type] ?? ""; }
function extractReadOnlySql(answer: string) {
  const fenced = answer.match(/```(?:sql)?\s*([\s\S]*?)```/i)?.[1]?.trim();
  const sql = (fenced || answer).trim().replace(/;+\s*$/, "");
  if (!/^(select|with|explain)\b/i.test(sql) || /\b(insert|update|delete|merge|drop|alter|truncate|create|grant|revoke|call|execute)\b/i.test(sql)) return "";
  return sql;
}

function connectionTypeOptions() {
  return <><optgroup label="API / Messaging"><option value="http">HTTP API</option><option value="websocket">WebSocket</option><option value="mqtt">MQTT</option><option value="amqp">AMQP</option><option value="kafka">Kafka</option><option value="coap">CoAP</option></optgroup><optgroup label="Database"><option value="postgresql">PostgreSQL</option><option value="mysql">MySQL</option><option value="oracle">Oracle</option><option value="tdengine">TDengine</option></optgroup><optgroup label="Industrial / IoT"><option value="opcua">OPC UA</option><option value="modbus">Modbus TCP</option><option value="bacnet">BACnet</option><option value="s7">Siemens S7</option><option value="ethernet-ip">EtherNet/IP</option><option value="snmp">SNMP</option><option value="tcp">TCP</option><option value="udp">UDP</option><option value="serial">Serial</option></optgroup></>;
}
