import { useState } from "react";
import { Box, PlugZap, Power, Save } from "lucide-react";
import type { AiModelProviderSettings, AiProviderSettings } from "@bim-studio/contracts";
import { api, type SystemPluginSummary } from "../api";
type Translate = (zh: string, en: string) => string;

export function AiPluginPanel({ t, plugins, onReload, onError }: { t: Translate; plugins: SystemPluginSummary[]; onReload: () => Promise<void>; onError: (value: string) => void }) {
  const [busyId, setBusyId] = useState("");
  const configurable = plugins.filter((plugin) => plugin.configurable);

  async function toggle(plugin: SystemPluginSummary) {
    const enabling = plugin.status !== "enabled";
    const name = pluginDisplayName(t, plugin);
    if (
      !confirm(enabling ? t(`启用“${name}”？`, `Enable “${name}”?`) : t(`停用“${name}”？相关入口会自动降级。`, `Disable “${name}”? Related entry points will degrade gracefully.`))
    )
      return;
    setBusyId(plugin.id);
    try {
      await api.setPluginEnabled(plugin.id, enabling);
      await onReload();
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusyId("");
    }
  }

  return (
    <section className="system-ai-plugins">
      <header>
        <span>
          <PlugZap size={18} />
          <strong>{t("AI 能力插件", "AI capability plugins")}</strong>
        </span>
        <small>{t("按场景独立启停；确定性底座不会随模型插件停用", "Toggle scenarios independently; deterministic foundations remain available")}</small>
      </header>
      <div>
        {configurable.map((plugin) => {
          const enabled = plugin.status === "enabled";
          const diagnostic = plugin.diagnostics.at(-1);
          return (
            <article key={plugin.id} className={plugin.status}>
              <span>
                <strong>{pluginDisplayName(t, plugin)}</strong>
                <small>
                  {plugin.id} · v{plugin.version}
                </small>
                <em>{[...plugin.capabilityIds, ...plugin.providerIds].join(" · ") || plugin.capabilities.join(" · ")}</em>
                {diagnostic && <i>{diagnostic.message}</i>}
              </span>
              <b>{enabled ? t("运行中", "Running") : plugin.status === "faulted" ? t("故障", "Faulted") : t("已停用", "Disabled")}</b>
              <button disabled={Boolean(busyId)} onClick={() => void toggle(plugin)}>
                <Power size={13} />
                {enabled ? t("停用", "Disable") : t("启用", "Enable")}
              </button>
            </article>
          );
        })}
      </div>
    </section>
  );
}

type Modeling3dProviderKey = "tripo3d" | "tencentHunyuan";
type Modeling3dSettings = Record<Modeling3dProviderKey, AiModelProviderSettings>;

const DEFAULT_MODELING_3D_SETTINGS: Modeling3dSettings = {
  tripo3d: {
    providerId: "ai.tripo3d",
    baseUrl: "https://openapi.tripo3d.ai",
    model: "tripo-3d",
    protocol: "auto",
  },
  tencentHunyuan: {
    providerId: "ai.tencent-hunyuan-3d",
    baseUrl: "https://ai3d.tencentcloudapi.com",
    model: "3.1",
    protocol: "auto",
    region: "ap-guangzhou",
  },
};

export function AiModelingSettingsPanel({
  t,
  initial,
  onSaved,
  onError,
}: {
  t: Translate;
  initial: AiProviderSettings["modeling3d"];
  onSaved: (value: AiProviderSettings) => void;
  onError: (value: string) => void;
}) {
  const [settings, setSettings] = useState<Modeling3dSettings>(() => ({
    tripo3d: { ...DEFAULT_MODELING_3D_SETTINGS.tripo3d, ...(initial?.tripo3d ?? {}) },
    tencentHunyuan: { ...DEFAULT_MODELING_3D_SETTINGS.tencentHunyuan, ...(initial?.tencentHunyuan ?? {}) },
  }));
  const [apiKeys, setApiKeys] = useState<Record<Modeling3dProviderKey, string>>({ tripo3d: "", tencentHunyuan: "" });
  const [secretIds, setSecretIds] = useState<Record<Modeling3dProviderKey, string>>({ tripo3d: "", tencentHunyuan: "" });
  const [busy, setBusy] = useState(false);
  const [activeProvider, setActiveProvider] = useState<Modeling3dProviderKey>("tripo3d");

  function update(provider: Modeling3dProviderKey, patch: Partial<AiModelProviderSettings>) {
    setSettings((current) => ({ ...current, [provider]: { ...current[provider], ...patch } }));
  }

  async function save() {
    setBusy(true);
    try {
      const modeling3d = {
        tripo3d: { ...settings.tripo3d, ...(apiKeys.tripo3d.trim() ? { apiKey: apiKeys.tripo3d.trim() } : {}) },
        tencentHunyuan: { ...settings.tencentHunyuan, ...(secretIds.tencentHunyuan.trim() ? { secretId: secretIds.tencentHunyuan.trim() } : {}), ...(apiKeys.tencentHunyuan.trim() ? { apiKey: apiKeys.tencentHunyuan.trim() } : {}) },
      };
      onSaved(await api.saveAiSettings({ modeling3d }));
      setApiKeys({ tripo3d: "", tencentHunyuan: "" });
      setSecretIds({ tripo3d: "", tencentHunyuan: "" });
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="system-ai-3d-settings">
      <header>
        <span>
          <Box size={18} />
          <strong>{t("3D 生成", "3D generation")}</strong>
        </span>
      </header>
      <nav className="system-ai-provider-tabs" aria-label={t("3D 生成供应商", "3D generation provider")}>
        <button type="button" className={activeProvider === "tripo3d" ? "active" : ""} onClick={() => setActiveProvider("tripo3d")}>Tripo3D</button>
        <button type="button" className={activeProvider === "tencentHunyuan" ? "active" : ""} onClick={() => setActiveProvider("tencentHunyuan")}>{t("混元 3D", "Hunyuan 3D")}</button>
      </nav>
      {(() => {
        const provider = activeProvider;
        const value = settings[provider];
        return (
          <article>
            <div className="system-ai-3d-card-heading">
              <strong>{provider === "tripo3d" ? t("Tripo3D", "Tripo3D") : t("腾讯混元 3D", "Tencent Hunyuan 3D")}</strong>
              <span className={(value.apiKeyConfigured || apiKeys[provider].trim()) && (provider === "tripo3d" || value.secretIdConfigured || secretIds[provider].trim()) ? "configured" : ""}>
                {(value.apiKeyConfigured || apiKeys[provider].trim()) && (provider === "tripo3d" || value.secretIdConfigured || secretIds[provider].trim()) ? t("已配置", "Configured") : t("未配置", "Not configured")}
              </span>
            </div>
            <label>
              <span>Base URL</span>
              <input value={value.baseUrl} onChange={(event) => update(provider, { baseUrl: event.target.value })} />
            </label>
            {provider === "tencentHunyuan" && <label>
              <span>{t("地域", "Region")}</span>
              <select value={value.region ?? "ap-guangzhou"} onChange={(event) => update(provider, { region: event.target.value })}>
                <option value="ap-guangzhou">ap-guangzhou</option>
                <option value="ap-shanghai">ap-shanghai</option>
              </select>
            </label>}
            {provider === "tencentHunyuan" && <label>
              <span>Secret ID</span>
              <input type="password" value={secretIds[provider]} placeholder={value.secretIdConfigured ? t("已配置，留空保持不变", "Configured; leave blank to keep") : "SecretId"} onChange={(event) => setSecretIds((current) => ({ ...current, [provider]: event.target.value }))} />
            </label>}
            <label>
              <span>{provider === "tripo3d" ? "API Key" : "Secret Key"}</span>
              <input
                type="password"
                value={apiKeys[provider]}
                placeholder={value.apiKeyConfigured ? t("已配置，留空保持不变", "Configured; leave blank to keep") : t("输入密钥", "Enter key")}
                onChange={(event) => setApiKeys((current) => ({ ...current, [provider]: event.target.value }))}
              />
            </label>
          </article>
        );
      })()}
      <footer>
        <button className="primary" disabled={busy} onClick={() => void save()}>
          <Save size={13} />
          {busy ? t("保存中…", "Saving…") : t("保存", "Save")}
        </button>
      </footer>
    </section>
  );
}

function pluginDisplayName(t: Translate, plugin: SystemPluginSummary): string {
  const names: Record<string, string> = {
    "bim.ai.openai-compatible": t("OpenAI 兼容模型", "OpenAI-compatible model"),
    "bim.ai.parametric-draft": t("AI 参数化建模草案", "AI parametric draft"),
    "bim.ai.data-query-draft": t("自然语言问数", "Natural-language Ask Data"),
    "bim.ai.industrial-diagnosis": t("工业证据诊断", "Industrial evidence diagnosis"),
  };
  return names[plugin.id] ?? plugin.name;
}
