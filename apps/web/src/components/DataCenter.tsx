import { useEffect, useMemo, useState } from "react";
import {
  Activity,
  AlertTriangle,
  Bot,
  Braces,
  CheckCircle2,
  Database,
  GitBranch,
  LoaderCircle,
  Pencil,
  Plus,
  RefreshCw,
  Send,
  ServerCog,
  Table2,
  Trash2,
  Workflow,
  X,
} from "lucide-react";
import type { DataConnectionRecord, DataConnectorDiagnostics, DataDatasetPreview, DataDatasetRecord, ProjectRecord } from "@bim-studio/contracts";
import { api } from "../api";
import { translate as tr, type AppLocale } from "../i18n";
import { DataEndpointStudio } from "./DataEndpointStudio";
import { DataPipelineStudio } from "./DataPipelineStudio";
import { NodeRedStudio } from "./NodeRedStudio";
import { SecondaryPageBack } from "./SecondaryPageBack";
import { ConnectionForm, DatasetForm } from "./DataCenterForms";
import {
  CONNECTOR_REQUIRED,
  SQL_CONNECTIONS,
  WRITABLE_CONNECTIONS,
  ConnectionIcon,
  DatasetPreview,
  FlowStep,
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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
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
  const [section, setSection] = useState<"data" | "pipeline" | "endpoint" | "node-red">("data");

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
    void load();
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
      setPreview(await api.previewDataset(project.id, datasetId));
      setSelectedDatasetId(datasetId);
      setError(undefined);
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
    try {
      const datasetId = datasets.find((item) => item.connectionId === connection.id)?.id;
      const result = await api.testDataConnection(project.id, connection.id, datasetId);
      if (!result.ok) throw new Error(result.message || tr(locale, "连接测试失败", "Connection test failed"));
      setError(tr(locale, `连接正常 · ${result.rowCount} 行样本 · ${result.durationMs}ms`, `Connection healthy · ${result.rowCount} sample rows · ${result.durationMs}ms`));
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
    try {
      const parsed = parseWriteValue(writeValue);
      await api.writeDataPoint(project.id, selectedConnection.id, { address: writeAddress.trim(), value: parsed });
      setError(tr(locale, `已向 ${writeAddress.trim()} 写入 ${formatCell(parsed)}`, `Wrote ${formatCell(parsed)} to ${writeAddress.trim()}`));
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
        <SecondaryPageBack locale={locale} onBack={onBack} />
        <div className="secondary-page-heading-row">
          <div className="data-center-title secondary-page-title">
            <small>PROJECT DATA HUB</small>
            <h1>{tr(locale, "数据中心", "Data center")}</h1>
            <p>
              {project.name} · {tr(locale, "连接、查询、预览，然后在 Studio 里直接绑定", "Connect, query, preview, then bind directly in Studio")}
            </p>
          </div>
        </div>
      </header>
      <section className="data-center-flow">
        <FlowStep
          icon={<Database />}
          index="1"
          title={tr(locale, "数据连接", "Connections")}
          caption={tr(locale, "数据库、接口、实时协议", "Databases, APIs and live protocols")}
        />
        <i />
        <FlowStep icon={<Table2 />} index="2" title={tr(locale, "数据集", "Datasets")} caption={tr(locale, "查询、字段和刷新策略", "Queries, fields and refresh")} />
        <i />
        <FlowStep icon={<Activity />} index="3" title={tr(locale, "场景绑定", "Scene binding")} caption={tr(locale, "进入 Studio 选择数据集", "Select a dataset in Studio")} />
      </section>
      {error && (
        <div className="data-center-error">
          <span>{error}</span>
          <button onClick={() => setError(undefined)}>
            <X size={14} />
          </button>
        </div>
      )}
      <nav className="data-hub-tabs">
        <button className={section === "data" ? "active" : ""} onClick={() => setSection("data")}>
          <Database size={14} />
          <span>
            <strong>{tr(locale, "数据准备", "Data preparation")}</strong>
            <small>{tr(locale, "连接、查询、字段", "Connections, queries, fields")}</small>
          </span>
        </button>
        <button className={section === "pipeline" ? "active" : ""} onClick={() => setSection("pipeline")}>
          <GitBranch size={14} />
          <span>
            <strong>{tr(locale, "逻辑编排", "Logic pipeline")}</strong>
            <small>{tr(locale, "节点、脚本、逐步诊断", "Nodes, scripts, diagnostics")}</small>
          </span>
        </button>
        <button className={section === "endpoint" ? "active" : ""} onClick={() => setSection("endpoint")}>
          <ServerCog size={14} />
          <span>
            <strong>{tr(locale, "接口服务", "Endpoint services")}</strong>
            <small>REST / WebSocket · API Key</small>
          </span>
        </button>
        <button className={section === "node-red" ? "active" : ""} onClick={() => setSection("node-red")}>
          <Workflow size={14} />
          <span>
            <strong>{tr(locale, "高级编排", "Advanced flows")}</strong>
            <small>Node-RED · IoT / Event</small>
          </span>
        </button>
      </nav>
      {section === "pipeline" ? (
        <DataPipelineStudio locale={locale} projectId={project.id} datasets={datasets} onError={(message) => setError(message || undefined)} />
      ) : section === "endpoint" ? (
        <DataEndpointStudio locale={locale} projectId={project.id} onError={(message) => setError(message || undefined)} />
      ) : section === "node-red" ? (
        <NodeRedStudio locale={locale} />
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
                      <strong>{connection.name}</strong>
                      <small>
                        {connectionLabel(connection.type)} ·{" "}
                        {CONNECTOR_REQUIRED.has(connection.type) ? tr(locale, "需要安装连接器", "Connector required") : connectionSummary(connection)}
                      </small>
                    </span>
                    <i className={connection.enabled && !CONNECTOR_REQUIRED.has(connection.type) ? "online" : ""} />
                  </button>
                  <div className="data-card-actions">
                    <button
                      disabled={CONNECTOR_REQUIRED.has(connection.type) || testingConnectionId === connection.id}
                      title={tr(locale, "测试连接", "Test connection")}
                      onClick={() => void testConnection(connection)}
                    >
                      {testingConnectionId === connection.id ? <LoaderCircle className="spin" size={13} /> : <Activity size={13} />}
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
            </div>
            {selectedConnection && (
              <section className={`data-connector-health-panel ${selectedDiagnostics?.status ?? "idle"}`}>
                <header>
                  <div>
                    <strong>{tr(locale, "连接运行监控", "Connector monitoring")}</strong>
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
            {selectedConnection && WRITABLE_CONNECTIONS.has(selectedConnection.type) && (
              <section className="data-write-panel">
                <header>
                  <div>
                    <strong>{tr(locale, "工业下行写入", "Industrial write")}</strong>
                    <small>
                      {tr(
                        locale,
                        "向当前连接写入一个点位；生产环境请先配置权限和审批策略。",
                        "Write one point to the selected connection; configure authorization and approval in production.",
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
              <DatasetPreview locale={locale} {...(preview ? { preview } : {})} />
            </div>
            {selectedDataset && !selectedConnectorUnavailable && (
              <footer>
                <div>
                  <CheckCircle2 size={15} />
                  <span>
                    <strong>{tr(locale, "可用于 Studio", "Ready for Studio")}</strong>
                    <small>{tr(locale, "数据看板中选择此数据集和字段即可生成组件。", "Select this dataset and a field in the dashboard.")}</small>
                  </span>
                </div>
              </footer>
            )}
          </section>
        </div>
      )}
    </main>
  );
}
