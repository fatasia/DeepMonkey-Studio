import { useEffect, useState } from "react";
import { Bot, KeyRound, Save } from "lucide-react";
import type { AiProviderSettings, AiTelemetrySummary } from "@bim-studio/contracts";
import { api, type AiProviderDescriptor } from "../api";
import { buildAiSettingsPayload, describeFailoverCategory, describeModelCatalogFailure, describeServedSummary, type AiReasoningEffortChoice } from "../ai/aiSettingsDraft";
type Translate = (zh: string, en: string) => string;

export function AiSettingsPanel({
  t,
  initial,
  providers,
  onSaved,
  onError,
}: {
  t: Translate;
  initial: AiProviderSettings;
  providers: AiProviderDescriptor[];
  onSaved: (value: AiProviderSettings) => void;
  onError: (value: string) => void;
}) {
  const [providerId, setProviderId] = useState(initial.providerId);
  const [baseUrl, setBaseUrl] = useState(initial.baseUrl);
  const [model, setModel] = useState(initial.model);
  const [protocol, setProtocol] = useState(initial.protocol);
  const [apiKey, setApiKey] = useState("");
  const [temperature, setTemperature] = useState(initial.temperature);
  const [reasoningEffort, setReasoningEffort] = useState<AiReasoningEffortChoice>(initial.reasoningEffort ?? "");
  const [failoverEnabled, setFailoverEnabled] = useState(initial.failover?.enabled ?? true);
  const [failoverBaseUrl, setFailoverBaseUrl] = useState(initial.failover?.baseUrl ?? "");
  const [failoverModel, setFailoverModel] = useState(initial.failover?.model ?? "");
  const [failoverApiKey, setFailoverApiKey] = useState("");
  const [modelOptions, setModelOptions] = useState<string[]>([]);
  const [catalogNotice, setCatalogNotice] = useState<string>();
  const [telemetry, setTelemetry] = useState<AiTelemetrySummary>();
  const [busy, setBusy] = useState(false);

  // 渐进增强：观测快照拉取失败时保持界面现状，不阻塞配置编辑。
  useEffect(() => {
    let cancelled = false;
    api.getAiTelemetry().then((snapshot) => { if (!cancelled) setTelemetry(snapshot.telemetry); }).catch(() => undefined);
    return () => { cancelled = true; };
  }, []);

  function draft() {
    return buildAiSettingsPayload({
      current: { providerId, baseUrl, model, protocol, temperature, apiKey },
      initial,
      reasoningEffort,
      failover: { enabled: failoverEnabled, baseUrl: failoverBaseUrl, model: failoverModel, apiKey: failoverApiKey },
    });
  }

  async function refreshModels(force = false) {
    setBusy(true);
    setCatalogNotice(undefined);
    try {
      const result = await api.fetchAiModels({ ...draft(), ...(force ? { refresh: true } : {}) });
      if (result.ok) {
        setModelOptions(result.models);
        if (!result.models.includes(model.trim())) setCatalogNotice(t("列表已更新，请从下拉中选择或直接输入模型名。", "Catalog updated; pick from the list or type a model name."));
      } else {
        setCatalogNotice(describeModelCatalogFailure(result.category, result.message, t));
      }
    } catch (reason) {
      setCatalogNotice(describeModelCatalogFailure("network", reason instanceof Error ? reason.message : String(reason), t));
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    setBusy(true);
    try {
      onSaved(await api.saveAiSettings(draft()));
      setApiKey("");
      setFailoverApiKey("");
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }
  async function test() {
    setBusy(true);
    try {
      const result = await api.testAiSettings(draft());
      alert(t(`连接成功：${result.model}`, `Connected: ${result.model}`));
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }
  const selectedProvider = providers.find((provider) => provider.id === providerId);
  const credentialContextChanged = providerId !== initial.providerId || baseUrl.replace(/\/$/, "") !== initial.baseUrl;
  const reasoningSupported = providerId === "ai.openai-compatible";
  const failoverConfigured = Boolean((initial.failover?.apiKeyConfigured ?? initial.failover?.apiKey) || failoverBaseUrl);
  const servedSummary = telemetry ? describeServedSummary(telemetry, failoverModel.trim() || undefined, t) : undefined;
  const lastFailover = telemetry?.lastFailover;
  return (
    <div className="system-ai-settings">
      <div className="system-ai-intro">
        <Bot size={24} />
        <span>
          <strong>{selectedProvider?.label ?? t("AI 模型服务", "AI model service")}</strong>
          <small>{t("用于场景助手、构件问答、受控问数和看板生成", "Scene, component, controlled data and dashboard assistants")}</small>
        </span>
      </div>
      <label>
        <span>{t("模型服务插件", "Model provider plugin")}</span>
        <select value={providerId} onChange={(event) => setProviderId(event.target.value)}>
          {!providers.some((provider) => provider.id === providerId) && <option value={providerId}>{providerId}</option>}
          {providers.map((provider) => (
            <option key={provider.id} value={provider.id}>
              {provider.label} · v{provider.version}
            </option>
          ))}
        </select>
      </label>
      <label>
        <span>Base URL</span>
        <input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} />
      </label>
      <label>
        <span>{t("模型名", "Model")}</span>
        <input value={model} list="ai-model-options" onChange={(event) => setModel(event.target.value)} />
        <datalist id="ai-model-options">
          {modelOptions.map((option) => <option key={option} value={option} />)}
        </datalist>
      </label>
      <label>
        <span>{t("接口协议", "API protocol")}</span>
        <select value={protocol} onChange={(event) => setProtocol(event.target.value as AiProviderSettings["protocol"])}>
          <option value="auto">{t("自动选择", "Auto")}</option>
          <option value="responses">Responses API</option>
          <option value="chat-completions">Chat Completions</option>
        </select>
      </label>
      <label>
        <span>API Key</span>
        <input
          type="password"
          value={apiKey}
          onChange={(event) => setApiKey(event.target.value)}
          placeholder={
            credentialContextChanged
              ? t("服务已变化，请输入对应密钥", "Provider changed; enter its API key")
              : initial.apiKeyConfigured
                ? t("已配置，留空保持不变", "Configured; leave blank to keep")
                : "sk-..."
          }
        />
      </label>
      <label>
        <span>Temperature</span>
        <input type="number" min="0" max="2" step="0.1" value={temperature} onChange={(event) => setTemperature(Number(event.target.value))} />
      </label>
      <label>
        <span>{t("思考深度", "Reasoning effort")}</span>
        <select
          value={reasoningEffort}
          disabled={!reasoningSupported}
          title={reasoningSupported
            ? t("映射到 Responses reasoning.effort / Chat reasoning_effort", "Maps to Responses reasoning.effort / Chat reasoning_effort")
            : t("当前模型服务插件不支持推理深度控制", "Current model provider does not support reasoning effort control")}
          onChange={(event) => setReasoningEffort(event.target.value as AiReasoningEffortChoice)}
        >
          <option value="">{t("默认（保持现有行为）", "Default (keep current behavior)")}</option>
          <option value="minimal">{t("最省（快速回答）", "Minimal (fastest)")}</option>
          <option value="standard">{t("标准", "Standard")}</option>
          <option value="deep">{t("深度（更慢更严谨）", "Deep (slower, more thorough)")}</option>
        </select>
        {!reasoningSupported && <small>{t("该控制仅对 OpenAI 兼容插件生效，其他插件已禁用并按默认行为请求。", "Only the OpenAI-compatible plugin supports this; others request with defaults.")}</small>}
      </label>
      <div className="system-ai-section" data-testid="ai-failover-section">
        <header>
          <strong>{t("备用模型自动切换", "Fallback model failover")}</strong>
          <small>{t("主模型出现额度、限流、服务端、超时或网络错误时，自动用备用配置重试一次；鉴权错误不切换。", "Retries once via the fallback on quota, rate-limit, server, timeout or network errors; auth errors never switch.")}</small>
        </header>
        <label className="system-ai-toggle">
          <input type="checkbox" checked={failoverEnabled} onChange={(event) => setFailoverEnabled(event.target.checked)} />
          <span>{failoverEnabled ? t("已启用", "Enabled") : t("已关闭", "Disabled")}</span>
        </label>
        <div>
          <label>
            <span>{t("备用 Base URL", "Fallback Base URL")}</span>
            <input value={failoverBaseUrl} placeholder={t("留空则使用服务器 AI_FALLBACK_BASE_URL", "Blank uses server AI_FALLBACK_BASE_URL")} onChange={(event) => setFailoverBaseUrl(event.target.value)} />
          </label>
          <label>
            <span>{t("备用模型名", "Fallback model")}</span>
            <input value={failoverModel} onChange={(event) => setFailoverModel(event.target.value)} />
          </label>
          <label>
            <span>{t("备用 API Key", "Fallback API key")}</span>
            <input
              type="password"
              value={failoverApiKey}
              onChange={(event) => setFailoverApiKey(event.target.value)}
              placeholder={initial.failover?.apiKeyConfigured ? t("已配置，留空保持不变", "Configured; leave blank to keep") : t("未配置，留空则使用服务器环境变量", "Not set; blank uses server environment")}
            />
          </label>
          <label>
            <span>{t("备用接口协议", "Fallback protocol")}</span>
            <span>{t("跟随上方接口协议设置", "Follows the API protocol above")}</span>
          </label>
        </div>
        <p className="system-ai-status" data-testid="ai-failover-status">
          {servedSummary
            ?? (lastFailover
              ? undefined
              : t("尚未有请求记录；主配置健康路径不会产生额外请求。", "No requests recorded yet; a healthy primary path adds no extra requests."))}
          {lastFailover && (
            <small>
              {t("最近一次切换", "Latest failover")}：
              {t("由备用模型", "served by fallback")} {lastFailover.model}
              {lastFailover.errorCategory ? ` · ${describeFailoverCategory(lastFailover.errorCategory, t)}` : ""}
            </small>
          )}
          {!failoverConfigured && !failoverBaseUrl && (
            <small>{t("备用模型尚未配置端点，切换策略处于待命状态。", "No fallback endpoint configured; the policy is on standby.")}</small>
          )}
        </p>
      </div>
      {catalogNotice && <p className="system-ai-catalog-notice" role="status">{catalogNotice}</p>}
      {telemetry && telemetry.records.length > 0 && (
        <div className="system-ai-telemetry" data-testid="ai-telemetry">
          <header>{t("最近请求（最新在后）", "Recent requests (newest last)")}</header>
          <ul>
            {telemetry.records.slice(-5).map((record) => (
              <li key={record.id}>
                {new Date(record.occurredAt).toLocaleTimeString()} · {record.servedBy === "fallback" ? t("备用", "fallback") : t("主", "primary")} {record.model} · {record.latencyMs} ms · {record.status === "completed" ? t("成功", "ok") : record.status === "cancelled" ? t("已取消", "cancelled") : record.errorCategory ?? t("失败", "failed")}
                {record.outputTokens !== undefined ? ` · ${t("输出", "out")} ${record.outputTokens} tok` : ""}
              </li>
            ))}
          </ul>
        </div>
      )}
      <footer>
        <button disabled={busy} onClick={() => void refreshModels(false)} title={t("从模型服务拉取可用模型列表", "Fetch the model catalog from the provider")}>
          <Bot size={13} />
          {t("拉取模型列表", "Fetch models")}
        </button>
        {modelOptions.length > 0 && (
          <button disabled={busy} onClick={() => void refreshModels(true)}>
            {t("刷新列表", "Refresh list")}
          </button>
        )}
        <button disabled={busy} onClick={() => void test()}>
          <KeyRound size={13} />
          {t("测试连接", "Test")}
        </button>
        <button className="primary" disabled={busy || !baseUrl.trim() || !model.trim() || (credentialContextChanged && !apiKey.trim())} onClick={() => void save()}>
          <Save size={13} />
          {t("保存配置", "Save settings")}
        </button>
      </footer>
    </div>
  );
}
