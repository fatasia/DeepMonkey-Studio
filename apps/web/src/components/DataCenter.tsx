import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import {
  Activity,
  AlertTriangle,
  Bot,
  Braces,
  CheckCircle2,
  Database,
  LoaderCircle,
  Pencil,
  Plus,
  RefreshCw,
  Send,
  Table2,
  Trash2,
  Workflow,
  X,
} from "lucide-react";
import type { DataConnectionRecord, DataConnectorDiagnostics, DataDatasetPreview, DataDatasetRecord, ProjectRecord } from "@bim-studio/contracts";
import { api } from "../api";
import { translate as tr, type AppLocale } from "../i18n";
import "../styles/data-center-workbench.css";
import "../styles/data-center-pipeline-workbench.css";
import "../styles/data-center-endpoint-workbench.css";
import { DataEndpointStudio } from "./DataEndpointStudio";
import { DataPipelineStudio } from "./DataPipelineStudio";
import { NodeRedStudio } from "./NodeRedStudio";
import { SecondaryPageBack } from "./SecondaryPageBack";
import { ConnectionForm, DatasetForm } from "./DataCenterForms";
import { datasetSchemaChanged } from "./datasetSchema";
const SemanticModelStudio = lazy(() => import("./SemanticModelStudio"));
import {
  CONNECTOR_REQUIRED,
  SQL_CONNECTIONS,
  WRITABLE_CONNECTIONS,
  ConnectionIcon,
  DatasetPreview,
  connectionLabel,
  connectionSummary,
  connectorStatusLabel,
  extractReadOnlySql,
  formatCell,
  parseWriteValue,
  writeAddressPlaceholder,
} from "./DataCenterPresentation";

export function DataCenter({ locale, project, onBack }: { locale: AppLocale; project: ProjectRecord; onBack: () => void }) {
  const [connections, setConnections] = useState<DataConnectionRecord[]>([]);
  const [diagnostics, setDiagnostics] = useState<DataConnectorDiagnostics[]>([]);
  const [datasets, setDatasets] = useState<DataDatasetRecord[]>([]);
  const [selectedConnectionId, setSelectedConnectionId] = useState<string>();
  const [selectedDatasetId, setSelectedDatasetId] = useState<string>();
  const [preview, setPreview] = useState<DataDatasetPreview>();
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [connectionEditor, setConnectionEditor] = useState<DataConnectionRecord | "new">();
  const [datasetEditor, setDatasetEditor] = useState<DataDatasetRecord | "new">();
  const [sqlAssistantOpen, setSqlAssistantOpen] = useState(false);
  const [sqlQuestion, setSqlQuestion] = useState("");
  const [sqlAnswer, setSqlAnswer] = useState("");
  const [sqlBusy, setSqlBusy] = useState(false);
  const [testingConnectionId, setTestingConnectionId] = useState<string>();
  const [writeAddress, setWriteAddress] = useState("");
  const [writeValue, setWriteValue] = useState("");
  const [writeBusy, setWriteBusy] = useState(false);
  const [section, setSection] = useState<"data" | "pipeline" | "endpoint" | "node-red" | "semantic">("data");
  const [endpointPipelineId, setEndpointPipelineId] = useState<string>();
  const [semanticMounted, setSemanticMounted] = useState(false);
  const [semanticDirty, setSemanticDirty] = useState(false);

  async function load(preferredConnectionId?: string, preferredDatasetId?: string) {
    setBusy(true);
    try {
      const [nextConnections, nextDatasets, nextDiagnostics] = await Promise.all([
        api.listDataConnections(project.id),
        api.listDatasets(project.id),
        api.listDataConnectionDiagnostics(project.id),
      ]);
      setConnections(nextConnections);
      setDatasets(nextDatasets);
      setDiagnostics(nextDiagnostics);
      const connectionId = preferredConnectionId ?? selectedConnectionId;
      const nextConnectionId = nextConnections.some((item) => item.id === connectionId) ? connectionId : nextConnections[0]?.id;
      setSelectedConnectionId(nextConnectionId);
      const datasetId = preferredDatasetId ?? selectedDatasetId;
      setSelectedDatasetId(
        nextDatasets.some((item) => item.id === datasetId && (!nextConnectionId || item.connectionId === nextConnectionId))
          ? datasetId
          : nextDatasets.find((item) => item.connectionId === nextConnectionId)?.id,
      );
      setError(undefined);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    setLoading(true);
    void load().finally(() => setLoading(false));
  }, [project.id]);
  const selectedDataset = datasets.find((item) => item.id === selectedDatasetId);
  const selectedConnection = connections.find((item) => item.id === selectedConnectionId);
  const selectedDiagnostics = diagnostics.find((item) => item.connectionId === selectedConnectionId);
  const selectedConnectorUnavailable = Boolean(selectedConnection && CONNECTOR_REQUIRED.has(selectedConnection.type));
  const connectionDatasets = useMemo(() => datasets.filter((item) => !selectedConnectionId || item.connectionId === selectedConnectionId), [datasets, selectedConnectionId]);

  async function inspect(datasetId = selectedDatasetId) {
    if (!datasetId) return;
    setBusy(true);
    try {
      const result = await api.previewDataset(project.id, datasetId);
      const current = datasets.find((item) => item.id === datasetId);
      const discoveredFields = result.fields.length > 0 ? result.fields : current?.fields ?? [];
      const hydrated = current && result.fields.length > 0 && datasetSchemaChanged(current.fields, discoveredFields)
        ? await api.createDataset(project.id, { ...result.dataset, fields: discoveredFields })
        : result.dataset;
      const effectiveDataset = { ...hydrated, fields: discoveredFields };
      setDatasets((items) => items.map((item) => item.id === effectiveDataset.id ? effectiveDataset : item));
      setPreview({ ...result, dataset: effectiveDataset, fields: discoveredFields });
      setSelectedDatasetId(datasetId);
      setError(undefined);
      setNotice(result.fields.length > 0
        ? tr(locale, `查询成功 · 已同步 ${result.fields.length} 个字段`, `Query succeeded · ${result.fields.length} fields synchronized`)
        : tr(locale, `查询成功但没有返回数据 · 保留 ${discoveredFields.length} 个已有字段`, `Query succeeded with no rows · kept ${discoveredFields.length} existing fields`));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }

  async function deleteConnection(connection: DataConnectionRecord) {
    if (!window.confirm(tr(locale, `删除连接“${connection.name}”及其数据集？`, `Delete “${connection.name}” and its datasets?`))) return;
    try {
      await api.deleteDataConnection(project.id, connection.id);
      setPreview(undefined);
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }

  async function testConnection(connection: DataConnectionRecord) {
    setTestingConnectionId(connection.id);
    setNotice(undefined);
    try {
      const datasetId = datasets.find((item) => item.connectionId === connection.id)?.id;
      const result = await api.testDataConnection(project.id, connection.id, datasetId);
      if (!result.ok) throw new Error(result.message || tr(locale, "连接测试失败", "Connection test failed"));
      setError(undefined);
      setNotice(tr(locale, `连接正常 · ${result.rowCount} 行样本 · ${result.durationMs}ms`, `Connection healthy · ${result.rowCount} sample rows · ${result.durationMs}ms`));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      try {
        setDiagnostics(await api.listDataConnectionDiagnostics(project.id));
      } catch {
        /* keep the last local snapshot */
      }
      setTestingConnectionId(undefined);
    }
  }

  async function writePoint() {
    if (!selectedConnection || !WRITABLE_CONNECTIONS.has(selectedConnection.type) || !writeAddress.trim()) return;
    setWriteBusy(true);
    setNotice(undefined);
    try {
      const parsed = parseWriteValue(writeValue);
      await api.writeDataPoint(project.id, selectedConnection.id, { address: writeAddress.trim(), value: parsed });
      setError(undefined);
      setNotice(tr(locale, `已向 ${writeAddress.trim()} 写入 ${formatCell(parsed)}`, `Wrote ${formatCell(parsed)} to ${writeAddress.trim()}`));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      try {
        setDiagnostics(await api.listDataConnectionDiagnostics(project.id));
      } catch {
        /* keep the last local snapshot */
      }
      setWriteBusy(false);
    }
  }

  async function deleteDataset(dataset: DataDatasetRecord) {
    if (!window.confirm(tr(locale, `删除数据集“${dataset.name}”？`, `Delete dataset “${dataset.name}”?`))) return;
    try {
      await api.deleteDataset(project.id, dataset.id);
      setPreview(undefined);
      await load(selectedConnectionId);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }

  async function askSqlAssistant() {
    if (!sqlQuestion.trim() || !selectedConnection) return;
    setSqlBusy(true);
    setSqlAnswer("");
    setError(undefined);
    try {
      const result = await api.streamAssistant(
        "sql",
        sqlQuestion.trim(),
        {
          connection: { name: selectedConnection.name, type: selectedConnection.type },
          dataset: selectedDataset ? { name: selectedDataset.name, query: selectedDataset.query, fields: selectedDataset.fields } : undefined,
        },
        (delta) => setSqlAnswer((current) => current + delta),
      );
      setSqlAnswer(result.text);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSqlBusy(false);
    }
  }

  async function applyGeneratedSql() {
    if (!selectedDataset || !selectedConnection) return;
    const sql = extractReadOnlySql(sqlAnswer);
    if (!sql) {
      setError(tr(locale, "未识别到安全的只读 SQL，请让助手只返回 SELECT、WITH 或 EXPLAIN 查询。", "No safe read-only SQL found. Ask for a SELECT, WITH or EXPLAIN query."));
      return;
    }
    try {
      const saved = await api.createDataset(project.id, { ...selectedDataset, query: sql });
      setSqlAssistantOpen(false);
      setSqlQuestion("");
      setSqlAnswer("");
      await load(selectedConnection.id, saved.id);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }

  return (
    <main className="data-center-page">
      <header className="data-center-header secondary-page-header">
        <SecondaryPageBack locale={locale} onBack={() => {
          if (!semanticDirty || window.confirm(tr(locale, "语义模型有未保存修改，仍要离开数据中心？", "Leave data center and discard the unsaved semantic model?"))) onBack();
        }} />
        <div className="secondary-page-heading-row">
          <div className="data-center-title secondary-page-title">
            <h1>{tr(locale, "数据中心", "Data center")}</h1>
            <p>
              {project.name} · {tr(locale, "接入、处理并发布可复用的数据接口", "Connect, transform and publish reusable data APIs")}
            </p>
          </div>
        </div>
      </header>
      {error && (
        <div className="data-center-error">
          <span>{error}</span>
          <button onClick={() => setError(undefined)}>
            <X size={14} />
          </button>
        </div>
      )}
      {notice && section === "data" && (
        <div className="data-center-notice success" role="status">
          <CheckCircle2 size={14} />
          <span>{notice}</span>
          <button aria-label={tr(locale, "关闭提示", "Dismiss message")} onClick={() => setNotice(undefined)}>
            <X size={14} />
          </button>
        </div>
      )}
      <nav className="data-hub-tabs">
        <button className={section === "data" ? "active" : ""} onClick={() => setSection("data")}>
          <b>1</b>
          <strong>{tr(locale, "接入数据", "Connect data")}</strong>
        </button>
        <button className={section === "pipeline" ? "active" : ""} onClick={() => setSection("pipeline")}>
          <b>2</b>
          <strong>{tr(locale, "处理逻辑", "Transform")}</strong>
        </button>
        <button className={section === "endpoint" ? "active" : ""} onClick={() => {
          setEndpointPipelineId(undefined);
          setSection("endpoint");
        }}>
          <b>3</b>
          <strong>{tr(locale, "发布接口", "Publish API")}</strong>
        </button>
        <button aria-label={tr(locale, "语义模型", "Semantic models")} className={section === "semantic" ? "active" : ""} onClick={() => { setSemanticMounted(true); setSection("semantic"); }}><Table2 size={14} /><strong>{tr(locale, "语义模型", "Semantic models")}</strong></button>
        <i />
        <button className={`data-hub-advanced ${section === "node-red" ? "active" : ""}`} onClick={() => setSection("node-red")}>
          <Workflow size={14} />
          <strong>{tr(locale, "高级接入", "Advanced")}</strong>
        </button>
      </nav>
      {semanticMounted && <div hidden={section !== "semantic"}>
        <Suspense fallback={<p role="status">{tr(locale, "正在加载语义模型…", "Loading semantic models…")}</p>}><SemanticModelStudio key={project.id} projectId={project.id} locale={locale} onDirtyChange={setSemanticDirty} /></Suspense>
      </div>}
      {section === "semantic" ? null : section === "pipeline" ? (
        <DataPipelineStudio
          locale={locale}
          projectId={project.id}
          datasets={datasets}
          onError={(message) => setError(message || undefined)}
          onOpenEndpoints={(pipelineId) => {
            setEndpointPipelineId(pipelineId);
            setSection("endpoint");
          }}
        />
      ) : section === "endpoint" ? (
        <DataEndpointStudio
          locale={locale}
          projectId={project.id}
          initialPipelineId={endpointPipelineId}
          onError={(message) => setError(message || undefined)}
        />
      ) : section === "node-red" ? (
        <NodeRedStudio locale={locale} />
      ) : loading ? (
        <div className="pipeline-blank data-center-loading">
          <LoaderCircle className="spin" size={28} />
          <strong>{tr(locale, "正在加载数据连接", "Loading data connections")}</strong>
        </div>
      ) : (
        <div className="data-center-columns">
          <section className="data-center-pane">
            <header>
              <div>
                <strong>{tr(locale, "数据连接", "Connections")}</strong>
                <span>
                  {connections.length} {tr(locale, "个连接", "connections")}
                </span>
              </div>
              <button onClick={() => setConnectionEditor("new")}>
                <Plus size={14} />
                {tr(locale, "新建", "New")}
              </button>
            </header>
            {connectionEditor && (
              <ConnectionForm
                locale={locale}
                projectId={project.id}
                {...(connectionEditor === "new" ? {} : { initial: connectionEditor })}
                onCancel={() => setConnectionEditor(undefined)}
                onError={setError}
                onSaved={(saved) => {
                  setConnectionEditor(undefined);
                  void load(saved.id);
                }}
              />
            )}
            {selectedConnection && (
              <section className={`data-connector-health-panel ${selectedDiagnostics?.status ?? "idle"}`}>
                <header>
                  <div>
                    <strong>{tr(locale, "连接运行监控", "Connector monitoring")}</strong>
                    <small title={selectedConnection.name}>{selectedConnection.name}</small>
                    <small>
                      {selectedDiagnostics
                        ? tr(
                            locale,
                            `${selectedDiagnostics.totalReads} 次读取 · ${selectedDiagnostics.totalWrites} 次写入 · ${selectedDiagnostics.reconnects} 次重连`,
                            `${selectedDiagnostics.totalReads} reads · ${selectedDiagnostics.totalWrites} writes · ${selectedDiagnostics.reconnects} reconnects`,
                          )
                        : tr(locale, "执行连接测试后开始记录", "Run a connection test to start collecting metrics")}
                    </small>
                  </div>
                  <i>{connectorStatusLabel(selectedDiagnostics?.status, locale)}</i>
                </header>
                {selectedDiagnostics && (
                  <div>
                    <span>
                      {tr(locale, "最近延迟", "Last latency")} <b>{selectedDiagnostics.lastLatencyMs ?? 0} ms</b>
                    </span>
                    <span>
                      {tr(locale, "连续失败", "Consecutive failures")} <b>{selectedDiagnostics.consecutiveFailures}</b>
                    </span>
                    <span>
                      {tr(locale, "总失败", "Total failures")} <b>{selectedDiagnostics.totalFailures}</b>
                    </span>
                  </div>
                )}
                {selectedDiagnostics?.lastError && <small title={selectedDiagnostics.lastError}>{selectedDiagnostics.lastError}</small>}
              </section>
            )}
            <div className="data-card-list">
              {connections.map((connection) => (
                <article
                  key={connection.id}
                  className={`data-resource-card ${selectedConnectionId === connection.id ? "active" : ""} ${CONNECTOR_REQUIRED.has(connection.type) ? "connector-required" : ""}`}
                >
                  <button
                    className="data-card-main"
                    onClick={() => {
                      setSelectedConnectionId(connection.id);
                      setSelectedDatasetId(datasets.find((item) => item.connectionId === connection.id)?.id);
                      setPreview(undefined);
                    }}
                  >
                    <ConnectionIcon type={connection.type} />
                    <span>
                      <strong title={connection.name}>{connection.name}</strong>
                      <small>
                        {connectionLabel(connection.type)} ·{" "}
                        {CONNECTOR_REQUIRED.has(connection.type) ? tr(locale, "需要安装连接器", "Connector required") : connectionSummary(connection)}
                      </small>
                    </span>
                    <i className={connection.enabled && !CONNECTOR_REQUIRED.has(connection.type) ? "online" : ""} />
                  </button>
                  <div className="data-card-actions">
                    <button
                      className="data-test-connection"
                      disabled={CONNECTOR_REQUIRED.has(connection.type) || testingConnectionId === connection.id}
                      title={tr(locale, "测试连接", "Test connection")}
                      onClick={() => void testConnection(connection)}
                    >
                      {testingConnectionId === connection.id ? <LoaderCircle className="spin" size={13} /> : <Activity size={13} />}
                      <span>{tr(locale, "测试", "Test")}</span>
                    </button>
                    <button title={tr(locale, "重命名或编辑", "Rename or edit")} onClick={() => setConnectionEditor(connection)}>
                      <Pencil size={13} />
                    </button>
                    <button className="danger" title={tr(locale, "删除", "Delete")} onClick={() => void deleteConnection(connection)}>
                      <Trash2 size={13} />
                    </button>
                  </div>
                </article>
              ))}
              {!connections.length && !connectionEditor && (
                <div className="data-list-empty">
                  <Database size={24} />
                  <strong>{tr(locale, "连接第一个数据源", "Connect your first data source")}</strong>
                  <span>{tr(locale, "从数据库、HTTP、文件或现场协议开始，保存后即可创建数据集。", "Start with a database, HTTP, file or industrial protocol, then create a dataset.")}</span>
                  <button onClick={() => setConnectionEditor("new")}><Plus size={13} />{tr(locale, "新建连接", "New connection")}</button>
                </div>
              )}
            </div>
            {selectedConnection && WRITABLE_CONNECTIONS.has(selectedConnection.type) && (
              <section className="data-write-panel">
                <header>
                  <div>
                    <strong>{tr(locale, "工业下行写入", "Industrial write")}</strong>
                    <small>
                      {tr(
                        locale,
                        "向当前连接写入一个点位；执行前会显示目标和值供你确认。",
                        "Write one point to the selected connection; review the target and value before execution.",
                      )}
                    </small>
                  </div>
                  <Send size={14} />
                </header>
                <div className="data-write-fields">
                  <label>
                    <span>{tr(locale, "点位地址", "Point address")}</span>
                    <input value={writeAddress} onChange={(event) => setWriteAddress(event.target.value)} placeholder={writeAddressPlaceholder(selectedConnection.type)} />
                  </label>
                  <label>
                    <span>{tr(locale, "值（JSON 或文本）", "Value (JSON or text)")}</span>
                    <input value={writeValue} onChange={(event) => setWriteValue(event.target.value)} placeholder='true / 42 / {"mode":"auto"}' />
                  </label>
                </div>
                <footer>
                  <small>
                    {tr(
                      locale,
                      "BACnet：objectType,instance,propertyId；S7：DB1,REAL0；Serial 使用 raw 可发送原始帧。",
                      "BACnet: objectType,instance,propertyId; S7: DB1,REAL0; Serial uses raw for an unwrapped frame.",
                    )}
                  </small>
                  <button className="primary" disabled={writeBusy || !writeAddress.trim()} onClick={() => void writePoint()}>
                    {writeBusy ? <LoaderCircle className="spin" size={13} /> : <Send size={13} />}
                    {tr(locale, "写入", "Write")}
                  </button>
                </footer>
              </section>
            )}
          </section>
          <section className="data-center-pane">
            <header>
              <div>
                <strong>{tr(locale, "数据集", "Datasets")}</strong>
                <span>
                  {connectionDatasets.length} {tr(locale, "个数据集", "datasets")}
                </span>
              </div>
              <button disabled={!selectedConnection || selectedConnectorUnavailable} onClick={() => setDatasetEditor("new")}>
                <Plus size={14} />
                {tr(locale, "新建", "New")}
              </button>
            </header>
            {selectedConnectorUnavailable && (
              <div className="data-connector-required">
                <AlertTriangle size={15} />
                <span>
                  <strong>{tr(locale, "当前连接不可运行", "Connection unavailable")}</strong>
                  <small>
                    {tr(
                      locale,
                      "安装对应连接器前，不能创建、编辑或预览其数据集。",
                      "Datasets cannot be created, edited, or previewed until the corresponding connector is installed.",
                    )}
                  </small>
                </span>
              </div>
            )}
            {datasetEditor && selectedConnection && !selectedConnectorUnavailable && (
              <DatasetForm
                locale={locale}
                projectId={project.id}
                connection={selectedConnection}
                {...(datasetEditor === "new" ? {} : { initial: datasetEditor })}
                onCancel={() => setDatasetEditor(undefined)}
                onError={setError}
                onSaved={(saved) => {
                  setDatasetEditor(undefined);
                  void load(selectedConnection.id, saved.id);
                }}
              />
            )}
            <div className="data-card-list">
              {connectionDatasets.map((dataset) => (
                <article key={dataset.id} className={`data-resource-card ${selectedDatasetId === dataset.id ? "active" : ""}`}>
                  <button disabled={selectedConnectorUnavailable} className="data-card-main" onClick={() => void inspect(dataset.id)}>
                    <Table2 size={17} />
                    <span>
                      <strong>{dataset.name}</strong>
                      <small>
                        {dataset.fields.length + (dataset.computedFields?.length ?? 0)} {tr(locale, "个字段", "fields")} ·{" "}
                        {dataset.refreshSeconds ? `${dataset.refreshSeconds}s` : tr(locale, "手动", "Manual")}
                      </small>
                    </span>
                    <Braces size={14} />
                  </button>
                  <div className="data-card-actions">
                    <button disabled={selectedConnectorUnavailable} title={tr(locale, "重命名或编辑", "Rename or edit")} onClick={() => setDatasetEditor(dataset)}>
                      <Pencil size={13} />
                    </button>
                    <button className="danger" title={tr(locale, "删除", "Delete")} onClick={() => void deleteDataset(dataset)}>
                      <Trash2 size={13} />
                    </button>
                  </div>
                </article>
              ))}
              {!connectionDatasets.length && !datasetEditor && (
                <div className="data-list-empty">
                  <Table2 size={24} />
                  <strong>{selectedConnection ? tr(locale, "定义可复用数据集", "Define a reusable dataset") : tr(locale, "先选择数据连接", "Select a connection first")}</strong>
                  <span>
                    {selectedConnection
                      ? tr(locale, "配置查询、字段和刷新频率，运行后立即预览结果。", "Configure the query, fields and refresh rate, then preview the result.")
                      : tr(locale, "数据集负责把原始连接整理成编排和场景可直接使用的输入。", "Datasets turn raw connections into inputs ready for pipelines and scenes.")}
                  </span>
                  {selectedConnection && !selectedConnectorUnavailable && (
                    <button onClick={() => setDatasetEditor("new")}><Plus size={13} />{tr(locale, "新建数据集", "New dataset")}</button>
                  )}
                </div>
              )}
            </div>
          </section>
          <section className="data-center-preview">
            <header>
              <div>
                <strong>{selectedDataset?.name ?? tr(locale, "数据预览", "Data preview")}</strong>
                <span>
                  {preview
                    ? `${preview.rows.length} ${tr(locale, "行", "rows")} · ${preview.durationMs.toFixed(0)}ms`
                    : tr(locale, "选择数据集并运行", "Select a dataset and run it")}
                </span>
              </div>
              <div className="data-preview-actions">
                <button
                  disabled={!selectedConnection || !SQL_CONNECTIONS.has(selectedConnection.type)}
                  className={sqlAssistantOpen ? "active" : ""}
                  onClick={() => setSqlAssistantOpen((value) => !value)}
                >
                  <Bot size={14} />
                  SQL {tr(locale, "助手", "Assistant")}
                </button>
                <button disabled={!selectedDataset || busy || selectedConnectorUnavailable} onClick={() => void inspect()}>
                  {busy ? <LoaderCircle className="spin" size={14} /> : <RefreshCw size={14} />}
                  {tr(locale, "运行查询", "Run query")}
                </button>
              </div>
            </header>
            <div className="data-preview-content">
              {sqlAssistantOpen && (
                <section className="data-sql-assistant">
                  <header>
                    <div>
                      <Bot size={16} />
                      <span>
                        <strong>SQL {tr(locale, "助手", "Assistant")}</strong>
                        <small>
                          {selectedConnection
                            ? `${connectionLabel(selectedConnection.type)} · ${selectedDataset?.name ?? tr(locale, "新查询", "New query")}`
                            : tr(locale, "请选择数据库连接", "Select a database connection")}
                        </small>
                      </span>
                    </div>
                    <button onClick={() => setSqlAssistantOpen(false)}>
                      <X size={13} />
                    </button>
                  </header>
                  <div className="data-sql-prompt">
                    <textarea
                      value={sqlQuestion}
                      onChange={(event) => setSqlQuestion(event.target.value)}
                      placeholder={tr(locale, "例如：按小时统计最近 7 天的平均温度，并解释索引建议", "For example: hourly average temperature over 7 days with index advice")}
                    />
                    <button disabled={sqlBusy || !sqlQuestion.trim()} onClick={() => void askSqlAssistant()}>
                      {sqlBusy ? <LoaderCircle className="spin" size={14} /> : <Send size={14} />}
                      {tr(locale, "生成", "Generate")}
                    </button>
                  </div>
                  {sqlAnswer ? (
                    <>
                      <pre>{sqlAnswer}</pre>
                      <footer>
                        <span>{tr(locale, "写入前会校验为只读查询", "Validated as read-only before applying")}</span>
                        <button disabled={!selectedDataset || sqlBusy} onClick={() => void applyGeneratedSql()}>
                          {tr(locale, "写入当前数据集", "Apply to dataset")}
                        </button>
                      </footer>
                    </>
                  ) : (
                    <div className="data-sql-empty">
                      {tr(locale, "可生成、解释或优化 SQL；助手会读取当前数据集字段和已有查询。", "Generate, explain or optimize SQL using the current dataset schema and query.")}
                    </div>
                  )}
                </section>
              )}
              <DatasetPreview locale={locale} {...(preview ? { preview } : {})} {...(selectedDataset ? { datasetName: selectedDataset.name } : {})} />
            </div>
            {selectedDataset && preview?.dataset.id === selectedDataset.id && preview.fields.length > 0 && !selectedConnectorUnavailable && (
              <footer>
                <div>
                  <CheckCircle2 size={15} />
                  <span>
                    <strong>{tr(locale, "字段已同步", "Schema synchronized")}</strong>
                    <small>{tr(locale, "继续编排处理逻辑，输出可供 2D、3D 与接口复用。", "Continue with transforms; the output can be reused by 2D, 3D and APIs.")}</small>
                  </span>
                </div>
                <button className="primary" onClick={() => setSection("pipeline")}>
                  <Workflow size={14} />
                  {tr(locale, "用这些字段编排", "Build pipeline with these fields")}
                </button>
              </footer>
            )}
          </section>
        </div>
      )}
    </main>
  );
}
