import { useEffect, useMemo, useState } from "react";
import {
  Check,
  Copy,
  Globe2,
  KeyRound,
  LoaderCircle,
  Play,
  Plus,
  Radio,
  RefreshCw,
  Save,
  ServerCog,
  Trash2,
} from "lucide-react";
import type {
  DataEndpointDefinition,
  DataEndpointKind,
  DataPipelineDefinition,
  DataPipelinePreview,
} from "@bim-studio/contracts";
import type { AppLocale } from "../i18n";
import { translate as tr } from "../i18n";
import { api } from "../api";

export function DataEndpointStudio({
  locale,
  projectId,
  initialPipelineId,
  onError,
}: {
  locale: AppLocale;
  projectId: string;
  initialPipelineId?: string | undefined;
  onError: (message: string) => void;
}) {
  const [endpoints, setEndpoints] = useState<DataEndpointDefinition[]>([]);
  const [pipelines, setPipelines] = useState<DataPipelineDefinition[]>([]);
  const [draft, setDraft] = useState<DataEndpointDefinition>();
  const [apiKey, setApiKey] = useState<string>();
  const [preview, setPreview] = useState<DataPipelinePreview>();
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  async function load(preferredId?: string) {
    setLoading(true);
    try {
      const [next, nextPipelines] = await Promise.all([
        api.listDataEndpoints(projectId),
        api.listDataPipelines(projectId),
      ]);
      setEndpoints(next);
      setPipelines(nextPipelines);
      const initialPipeline = nextPipelines.find((item) => item.id === initialPipelineId);
      const selected = next.find((item) => item.id === preferredId) ?? next[0];
      setDraft(initialPipeline
        ? createEndpointDraft(projectId, initialPipeline.id, "rest")
        : selected ? structuredClone(selected) : undefined);
      setApiKey(undefined);
      setPreview(undefined);
      onError("");
    } catch (reason) {
      onError(errorMessage(reason));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, [projectId, initialPipelineId]);

  function createEndpoint(kind: DataEndpointKind = "rest") {
    const pipeline = pipelines[0];
    if (!pipeline) {
      onError(
        tr(locale, "请先保存一条逻辑流水线。", "Save a logic pipeline first."),
      );
      return;
    }
    setDraft(createEndpointDraft(projectId, pipeline.id, kind));
    setApiKey(undefined);
    setPreview(undefined);
    onError("");
  }

  async function save(rotateKey = false) {
    if (!draft) return;
    setBusy(true);
    onError("");
    try {
      const result = await api.saveDataEndpoint(projectId, {
        ...draft,
        rotateKey,
      });
      setDraft(result.endpoint);
      setEndpoints((current) => [
        ...current.filter((item) => item.id !== result.endpoint.id),
        result.endpoint,
      ]);
      if (result.apiKey) setApiKey(result.apiKey);
      setCopied(false);
    } catch (reason) {
      onError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  }

  async function test() {
    if (!draft || !endpoints.some((item) => item.id === draft.id)) {
      onError(
        tr(
          locale,
          "请先保存接口，再运行测试。",
          "Save the endpoint before testing.",
        ),
      );
      return;
    }
    setBusy(true);
    onError("");
    try {
      const result = await api.testDataEndpoint(projectId, draft.id);
      setPreview(result);
      if (result.error) onError(result.error);
    } catch (reason) {
      onError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  }

  async function remove(endpoint: DataEndpointDefinition) {
    if (
      !window.confirm(
        tr(
          locale,
          `删除接口“${endpoint.name}”？`,
          `Delete endpoint “${endpoint.name}”?`,
        ),
      )
    )
      return;
    try {
      await api.deleteDataEndpoint(projectId, endpoint.id);
      await load();
    } catch (reason) {
      onError(errorMessage(reason));
    }
  }

  async function copyApiKey() {
    if (!apiKey) return;
    await navigator.clipboard.writeText(apiKey);
    setCopied(true);
  }

  const runtimePath = draft
    ? `/runtime/data/${projectId}/${draft.kind === "rest" ? "rest" : "ws"}/${draft.slug}`
    : "";
  const selectedPipeline = pipelines.find(
    (pipeline) => pipeline.id === draft?.pipelineId,
  );
  const successfulNodes = useMemo(
    () =>
      preview?.diagnostics.filter((item) => item.status === "success").length ??
      0,
    [preview],
  );

  return (
    <div className="endpoint-studio">
      <aside className="endpoint-library">
        <header>
          <span>
            <strong>{tr(locale, "接口服务", "Endpoint services")}</strong>
            <small>{loading ? tr(locale, "加载中", "Loading") : `${endpoints.length} REST / WebSocket`}</small>
          </span>
          <button disabled={loading || !pipelines.length} onClick={() => createEndpoint()}>
            <Plus size={14} />
            {tr(locale, "新建", "New")}
          </button>
        </header>
        <div className="endpoint-list">
          {endpoints.map((endpoint) => (
            <article
              className={draft?.id === endpoint.id ? "active" : ""}
              key={endpoint.id}
            >
              <button
                onClick={() => {
                  setDraft(structuredClone(endpoint));
                  setApiKey(undefined);
                  setPreview(undefined);
                }}
              >
                <span>
                  {endpoint.kind === "rest" ? (
                    <Globe2 size={16} />
                  ) : (
                    <Radio size={16} />
                  )}
                </span>
                <i>
                  <strong>{endpoint.name}</strong>
                  <small>
                    {endpoint.kind.toUpperCase()} · /{endpoint.slug}
                  </small>
                </i>
                <b className={endpoint.enabled ? "online" : ""} />
              </button>
              <button
                className="danger"
                title={tr(locale, "删除", "Delete")}
                onClick={() => void remove(endpoint)}
              >
                <Trash2 size={13} />
              </button>
            </article>
          ))}
        </div>
        {!endpoints.length && (
          <div className="endpoint-empty">
            <ServerCog size={25} />
            <strong>
              {tr(
                locale,
                "把数据产品变成接口",
                "Turn data products into endpoints",
              )}
            </strong>
            <span>
              {tr(
                locale,
                "同一条流水线可以供编辑器绑定，也可以安全地提供给外部系统。",
                "The same pipeline can power editor bindings and external systems.",
              )}
            </span>
          </div>
        )}
      </aside>
      <section className="endpoint-workspace">
        {!draft && loading ? (
          <div className="endpoint-blank">
            <LoaderCircle className="spin" size={28} />
            <strong>{tr(locale, "正在加载数据产品", "Loading data products")}</strong>
          </div>
        ) : !draft ? (
          <div className="endpoint-blank">
            <ServerCog size={34} />
            <strong>
              {tr(
                locale,
                "声明式 REST 与 WebSocket",
                "Declarative REST and WebSocket",
              )}
            </strong>
            <span>
              {pipelines.length
                ? tr(
                    locale,
                    "选择协议和流水线，平台负责认证、限流、错误与消息封装。",
                    "Choose a protocol and pipeline; the platform handles authentication, budgets and envelopes.",
                  )
                : tr(
                    locale,
                    "先在逻辑编排中保存一条流水线。",
                    "Save a pipeline in Logic pipeline first.",
                  )}
            </span>
            <div>
              <button
                disabled={!pipelines.length}
                onClick={() => createEndpoint("rest")}
              >
                <Globe2 size={14} />
                REST
              </button>
              <button
                disabled={!pipelines.length}
                onClick={() => createEndpoint("websocket")}
              >
                <Radio size={14} />
                WebSocket
              </button>
            </div>
          </div>
        ) : (
          <>
            <header className="endpoint-toolbar">
              <div>
                <span className={draft.enabled ? "online" : ""} />
                <strong>
                  {draft.name || tr(locale, "未命名接口", "Untitled endpoint")}
                </strong>
                <small>
                  {draft.kind === "rest"
                    ? `${draft.method ?? "GET"} ${runtimePath}`
                    : `WSS ${runtimePath}`}
                </small>
              </div>
              <div>
                <button disabled={busy} onClick={() => void test()}>
                  {busy ? (
                    <LoaderCircle className="spin" size={14} />
                  ) : (
                    <Play size={14} />
                  )}
                  {tr(locale, "测试", "Test")}
                </button>
                <button
                  className="primary"
                  disabled={busy || !draft.name.trim() || !draft.slug.trim()}
                  onClick={() => void save()}
                >
                  <Save size={14} />
                  {tr(locale, "保存", "Save")}
                </button>
              </div>
            </header>
            <div className="endpoint-content">
              <section className="endpoint-form">
                <header>
                  <span>
                    <strong>
                      {tr(locale, "接口契约", "Endpoint contract")}
                    </strong>
                    <small>
                      {tr(
                        locale,
                        "路径、数据产品和运行预算",
                        "Path, data product and runtime budgets",
                      )}
                    </small>
                  </span>
                </header>
                <div className="endpoint-form-body">
                  <div className="endpoint-field-pair">
                    <label>
                      <span>{tr(locale, "名称", "Name")}</span>
                      <input
                        value={draft.name}
                        onChange={(event) =>
                          setDraft({ ...draft, name: event.target.value })
                        }
                      />
                    </label>
                    <label>
                      <span>{tr(locale, "协议", "Protocol")}</span>
                      <select
                        value={draft.kind}
                        onChange={(event) => {
                          const kind = event.target.value as DataEndpointKind;
                          const {
                            method: _method,
                            channel: _channel,
                            intervalMs: _intervalMs,
                            ...base
                          } = draft;
                          setDraft(
                            kind === "rest"
                              ? { ...base, kind, method: "GET" }
                              : {
                                  ...base,
                                  kind,
                                  channel: draft.slug,
                                  intervalMs: 5_000,
                                },
                          );
                        }}
                      >
                        <option value="rest">REST</option>
                        <option value="websocket">WebSocket</option>
                      </select>
                    </label>
                  </div>
                  <label>
                    <span>{tr(locale, "接口路径", "Endpoint path")}</span>
                    <div className="endpoint-path-input">
                      <code>{draft.kind === "rest" ? "/rest/" : "/ws/"}</code>
                      <input
                        value={draft.slug}
                        onChange={(event) =>
                          setDraft({
                            ...draft,
                            slug: event.target.value
                              .toLowerCase()
                              .replace(/[^a-z0-9_-]/g, ""),
                          })
                        }
                      />
                    </div>
                  </label>
                  <label>
                    <span>{tr(locale, "逻辑流水线", "Logic pipeline")}</span>
                    <select
                      value={draft.pipelineId}
                      onChange={(event) =>
                        setDraft({ ...draft, pipelineId: event.target.value })
                      }
                    >
                      {pipelines.map((pipeline) => (
                        <option key={pipeline.id} value={pipeline.id}>
                          {pipeline.name}
                        </option>
                      ))}
                    </select>
                    <small>
                      {selectedPipeline?.nodes.length ?? 0}{" "}
                      {tr(
                        locale,
                        "个节点，接口与 2D/3D 共用同一输出",
                        "nodes; endpoint, 2D and 3D share the same output",
                      )}
                    </small>
                  </label>
                  {draft.kind === "rest" ? (
                    <label>
                      <span>HTTP Method</span>
                      <select
                        value={draft.method ?? "GET"}
                        onChange={(event) =>
                          setDraft({
                            ...draft,
                            method: event.target.value as "GET" | "POST",
                          })
                        }
                      >
                        <option>GET</option>
                        <option>POST</option>
                      </select>
                    </label>
                  ) : (
                    <div className="endpoint-field-pair">
                      <label>
                        <span>Channel</span>
                        <input
                          value={draft.channel ?? ""}
                          onChange={(event) =>
                            setDraft({ ...draft, channel: event.target.value })
                          }
                        />
                      </label>
                      <label>
                        <span>{tr(locale, "推送间隔", "Push interval")}</span>
                        <select
                          value={draft.intervalMs ?? 5_000}
                          onChange={(event) =>
                            setDraft({
                              ...draft,
                              intervalMs: Number(event.target.value),
                            })
                          }
                        >
                          <option value="1000">1s</option>
                          <option value="5000">5s</option>
                          <option value="10000">10s</option>
                          <option value="30000">30s</option>
                        </select>
                      </label>
                    </div>
                  )}
                  <div className="endpoint-field-pair">
                    <label>
                      <span>{tr(locale, "每分钟上限", "Requests/min")}</span>
                      <input
                        type="number"
                        min="1"
                        max="600"
                        value={draft.requestsPerMinute}
                        onChange={(event) =>
                          setDraft({
                            ...draft,
                            requestsPerMinute: Math.max(
                              1,
                              Math.min(600, Number(event.target.value)),
                            ),
                          })
                        }
                      />
                    </label>
                    <label className="endpoint-toggle">
                      <span>{tr(locale, "运行状态", "Runtime status")}</span>
                      <button
                        className={draft.enabled ? "active" : ""}
                        onClick={() =>
                          setDraft({ ...draft, enabled: !draft.enabled })
                        }
                      >
                        <i />
                        {draft.enabled
                          ? tr(locale, "已启用", "Enabled")
                          : tr(locale, "已停用", "Disabled")}
                      </button>
                    </label>
                  </div>
                </div>
              </section>
              <section className="endpoint-runtime">
                <header>
                  <span>
                    <strong>
                      {tr(locale, "调用与安全", "Invocation and security")}
                    </strong>
                    <small>
                      {tr(
                        locale,
                        "密钥仅显示一次，服务器只保存哈希",
                        "Keys are shown once; only hashes are stored",
                      )}
                    </small>
                  </span>
                </header>
                <div className="endpoint-runtime-body">
                  <div className="endpoint-url">
                    <span>
                      {draft.kind === "rest" ? (draft.method ?? "GET") : "WSS"}
                    </span>
                    <code>{runtimePath}</code>
                  </div>
                  {apiKey ? (
                    <div className="endpoint-secret">
                      <KeyRound size={17} />
                      <span>
                        <strong>
                          {tr(
                            locale,
                            "立即保存 API Key",
                            "Save the API key now",
                          )}
                        </strong>
                        <small>
                          {tr(
                            locale,
                            "关闭后无法再次查看，只能轮换。",
                            "It cannot be shown again; rotate it if lost.",
                          )}
                        </small>
                        <code>{apiKey}</code>
                        <small className="endpoint-auth-hint">
                          {draft.kind === "websocket"
                            ? "Sec-WebSocket-Protocol: bim-studio-key.<API_KEY>"
                            : "Authorization: Bearer <API_KEY>"}
                        </small>
                      </span>
                      <button onClick={() => void copyApiKey()}>
                        {copied ? <Check size={14} /> : <Copy size={14} />}
                        {copied
                          ? tr(locale, "已复制", "Copied")
                          : tr(locale, "复制", "Copy")}
                      </button>
                    </div>
                  ) : (
                    <div className="endpoint-key-summary">
                      <KeyRound size={16} />
                      <span>
                        <strong>
                          {draft.apiKeyHint ||
                            tr(
                              locale,
                              "保存后生成密钥",
                              "Key generated on save",
                            )}
                        </strong>
                        <small>
                          {draft.kind === "websocket"
                            ? "Sec-WebSocket-Protocol: bim-studio-key.<API_KEY>"
                            : "Authorization: Bearer <API_KEY>"}
                        </small>
                      </span>
                      {endpoints.some((item) => item.id === draft.id) && (
                        <button disabled={busy} onClick={() => void save(true)}>
                          <RefreshCw size={13} />
                          {tr(locale, "轮换密钥", "Rotate key")}
                        </button>
                      )}
                    </div>
                  )}
                  {preview ? (
                    <div className={`endpoint-test-result ${preview.status}`}>
                      <header>
                        <span>
                          {preview.status === "success" ? (
                            <Check size={15} />
                          ) : (
                            <LoaderCircle size={15} />
                          )}
                          <strong>
                            {preview.status === "success"
                              ? tr(locale, "测试通过", "Test passed")
                              : tr(locale, "测试失败", "Test failed")}
                          </strong>
                        </span>
                        <small>
                          {preview.rows.length} {tr(locale, "行", "rows")} ·{" "}
                          {preview.durationMs.toFixed(1)}ms · {successfulNodes}/
                          {preview.pipeline.nodes.length}{" "}
                          {tr(locale, "节点", "nodes")}
                        </small>
                      </header>
                      {preview.error && <p>{preview.error}</p>}
                      <div>
                        {preview.diagnostics.map((item) => (
                          <span className={item.status} key={item.nodeId}>
                            <i />
                            {
                              preview.pipeline.nodes.find(
                                (node) => node.id === item.nodeId,
                              )?.name
                            }
                            <small>
                              {item.inputRows} → {item.outputRows} ·{" "}
                              {item.durationMs.toFixed(1)}ms
                            </small>
                          </span>
                        ))}
                      </div>
                    </div>
                  ) : (
                    <div className="endpoint-test-empty">
                      <Play size={22} />
                      <span>
                        <strong>
                          {tr(locale, "保存后可测试", "Test after saving")}
                        </strong>
                        <small>
                          {tr(
                            locale,
                            "测试使用当前用户权限，不会泄露 API Key。",
                            "Tests use your current user session and never expose the API key.",
                          )}
                        </small>
                      </span>
                    </div>
                  )}
                </div>
              </section>
            </div>
          </>
        )}
      </section>
    </div>
  );
}

function createEndpointDraft(
  projectId: string,
  pipelineId: string,
  kind: DataEndpointKind,
): DataEndpointDefinition {
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  return {
    id,
    projectId,
    name: kind === "rest" ? "REST API" : "WebSocket",
    kind,
    slug: `data-${id.slice(0, 6)}`,
    pipelineId,
    enabled: true,
    apiKeyHint: "",
    ...(kind === "rest"
      ? { method: "GET" }
      : { channel: "realtime", intervalMs: 5_000 }),
    requestsPerMinute: 60,
    createdAt: now,
    updatedAt: now,
  };
}

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}
