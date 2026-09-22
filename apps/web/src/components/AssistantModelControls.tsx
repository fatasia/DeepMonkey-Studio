import { useEffect, useState } from "react";
import { api } from "../api";
import type { AssistantMode, AssistantSessionCatalog, AssistantSessionOptions } from "../apiClients/aiApi";
import { translate, type AppLocale } from "../i18n";
import "../styles/assistant-model-controls.css";
export type { AssistantSessionOptions } from "../apiClients/aiApi";

export function AssistantModelControls({ locale, mode, value, onChange, disabled = false }: {
  locale: AppLocale; mode: AssistantMode; value: AssistantSessionOptions;
  onChange: (value: AssistantSessionOptions) => void; disabled?: boolean;
}) {
  const t = (zh: string, en: string) => translate(locale, zh, en);
  const [catalog, setCatalog] = useState<AssistantSessionCatalog>();
  const [error, setError] = useState(false);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let current = true;
    setError(false);
    void api.getAssistantModels().then(result => { if (current) setCatalog(result); })
      .catch(() => { if (current) setError(true); });
    return () => { current = false; };
  }, [revision]);
  const efforts = catalog?.models.find(item => item.id === (value.model ?? catalog.defaultModel))?.reasoningEfforts ?? [];
  useEffect(() => {
    if (!catalog || disabled) return;
    if (value.model && !catalog.models.some(item => item.id === value.model)) {
      if (catalog.catalogAvailable) onChange({});
      return;
    }
    if (value.reasoningEffort && !efforts.includes(value.reasoningEffort)) onChange(value.model ? { model: value.model } : {});
  }, [catalog, value.model, value.reasoningEffort, disabled, onChange]);
  const inactive = disabled || mode === "sql" || !catalog;
  const effortLabel = { minimal: t("简短", "Brief"), standard: t("标准", "Standard"), deep: t("深入", "Deep") };
  return <div className="assistant-model-controls">
    <label><span>{t("模型", "Model")}</span><select aria-label={t("会话模型", "Session model")} disabled={inactive}
      value={value.model ?? ""} onChange={event => onChange(event.target.value ? { model: event.target.value } : {})}>
      <option value="">{t("服务默认", "Service default")}{catalog ? ` · ${catalog.defaultModel}` : ""}</option>
      {catalog?.models.map(model => <option key={model.id} value={model.id}>{model.id}</option>)}
    </select></label>
    <label><span>{t("思考", "Reasoning")}</span><select aria-label={t("会话思考档位", "Session reasoning effort")}
      disabled={inactive || efforts.length === 0} value={value.reasoningEffort ?? ""}
      title={efforts.length ? t("仅对本次会话生效", "Applies to this session only") : t("此模型未配置思考档位，使用服务默认", "Reasoning levels are not configured for this model; using service defaults")}
      onChange={event => onChange({ ...(value.model ? { model: value.model } : {}), ...(event.target.value ? { reasoningEffort: event.target.value as NonNullable<AssistantSessionOptions["reasoningEffort"]> } : {}) })}>
      <option value="">{t("服务默认", "Service default")}</option>
      {efforts.map(effort => <option key={effort} value={effort}>{effortLabel[effort]}</option>)}
    </select></label>
    {mode === "sql" ? <small>{t("问数使用受控查询服务", "Data queries use the managed query service")}</small>
      : error || catalog?.catalogAvailable === false ? <button type="button" disabled={disabled} onClick={() => setRevision(n => n + 1)}>{t("模型列表加载失败，重试", "Model list unavailable; retry")}</button>
        : <small>{!catalog ? t("正在读取模型…", "Loading models…") : !catalog.catalogAvailable
          ? t("模型目录不可用，仅显示已配置模型", "Model directory unavailable; showing the configured model") : efforts.length
          ? t("仅本次会话 · 支持思考档位", "This session only · reasoning levels supported")
          : t("仅本次会话 · 思考使用服务默认", "This session only · service-default reasoning")}</small>}
  </div>;
}
