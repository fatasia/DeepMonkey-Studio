import { useEffect, useState } from "react";
import type { AiAssistantRoute } from "@bim-studio/contracts";
import { api } from "../api";
import type { AssistantMode, AssistantSessionCatalog, AssistantSessionOptions } from "../apiClients/aiApi";
import { translate, type AppLocale } from "../i18n";
import "../styles/assistant-model-controls.css";
export type { AssistantSessionOptions } from "../apiClients/aiApi";

/** 下拉里「自动」项的取值；不会作为模型名发送。 */
const AUTO_VALUE = "__auto__";

export function AssistantModelControls({ locale, mode, value, onChange, disabled = false, compact = false, allowAuto = false, lastRoute }: {
  locale: AppLocale; mode: AssistantMode; value: AssistantSessionOptions;
  onChange: (value: AssistantSessionOptions) => void; disabled?: boolean;
  /** 紧凑档：嵌入输入框工具栏，只保留模型下拉（及模型支持时的思考档位），说明文案收进 title。 */
  compact?: boolean;
  /** 紧凑档提供「自动」项（服务端配置了小模型才会出现）；Agent 决策等规划场景不应开启。 */
  allowAuto?: boolean;
  /** 上一次回答的实际路由回执：自动模式下在下拉里显示实际选用的模型。 */
  lastRoute?: AiAssistantRoute | undefined;
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
  const autoOffered = allowAuto && Boolean(catalog?.routing?.autoAvailable);
  const auto = value.routing === "auto" && autoOffered;
  const keepRouting = value.routing ? { routing: value.routing } : {};
  useEffect(() => {
    if (!catalog || disabled) return;
    if (value.routing === "auto" && !autoOffered) {
      onChange({ ...(value.model ? { model: value.model } : {}), ...(value.reasoningEffort ? { reasoningEffort: value.reasoningEffort } : {}) });
      return;
    }
    if (value.model && !catalog.models.some(item => item.id === value.model)) {
      if (catalog.catalogAvailable) onChange({});
      return;
    }
    if (value.reasoningEffort && !efforts.includes(value.reasoningEffort)) onChange({ ...(value.model ? { model: value.model } : {}), ...keepRouting });
  }, [catalog, value.model, value.reasoningEffort, value.routing, autoOffered, disabled, onChange]);
  const inactive = disabled || mode === "sql" || !catalog;
  const effortLabel = { minimal: t("简短", "Brief"), standard: t("标准", "Standard"), deep: t("深入", "Deep") };
  const catalogFailed = error || catalog?.catalogAvailable === false;
  const routing = catalog?.routing;
  const autoLabel = auto && lastRoute ? `${t("自动", "Auto")} · ${lastRoute.model}` : t("自动", "Auto");
  const autoTitle = routing?.fastModel
    ? t(`自动：简单只读问答用 ${routing.fastModel}，规划、写操作与复杂请求用 ${routing.strongModel}`, `Auto: simple read-only questions use ${routing.fastModel}; planning, write actions and complex requests use ${routing.strongModel}`)
    : t("自动选择模型", "Choose the model automatically");
  const retryButton = <button type="button" disabled={disabled} onClick={() => setRevision(n => n + 1)}>{t("模型列表加载失败，重试", "Model list unavailable; retry")}</button>;
  if (compact) {
    if (mode === "sql") return null;
    if (catalogFailed && !catalog?.models.length) return <div className="assistant-model-controls is-compact">{retryButton}</div>;
    return <div className="assistant-model-controls is-compact">
      <select aria-label={t("会话模型", "Session model")} disabled={inactive}
        title={!catalog ? t("正在读取模型…", "Loading models…") : auto ? autoTitle : t("会话模型（仅本次会话）", "Session model (this session only)")}
        value={auto ? AUTO_VALUE : value.model && value.model !== catalog?.defaultModel ? value.model : ""}
        onChange={event => onChange(event.target.value === AUTO_VALUE ? { routing: "auto", ...(value.reasoningEffort ? { reasoningEffort: value.reasoningEffort } : {}) }
          : event.target.value ? { model: event.target.value } : {})}>
        <option value="">{catalog ? catalog.defaultModel : t("默认模型", "Default model")}</option>
        {autoOffered && <option value={AUTO_VALUE} title={autoTitle}>{autoLabel}</option>}
        {catalog?.models.filter(model => model.id !== catalog.defaultModel).map(model => <option key={model.id} value={model.id}>{model.id}</option>)}
      </select>
      {efforts.length > 0 && <select aria-label={t("会话思考档位", "Session reasoning effort")} disabled={inactive}
        title={t("思考档位（仅本次会话）", "Reasoning effort (this session only)")} value={value.reasoningEffort ?? ""}
        onChange={event => onChange({ ...(value.model ? { model: value.model } : {}), ...keepRouting, ...(event.target.value ? { reasoningEffort: event.target.value as NonNullable<AssistantSessionOptions["reasoningEffort"]> } : {}) })}>
        <option value="">{t("思考·默认", "Reasoning·default")}</option>
        {efforts.map(effort => <option key={effort} value={effort}>{effortLabel[effort]}</option>)}
      </select>}
      {catalogFailed && retryButton}
    </div>;
  }
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
      : catalogFailed ? retryButton
        : <small>{!catalog ? t("正在读取模型…", "Loading models…") : !catalog.catalogAvailable
          ? t("模型目录不可用，仅显示已配置模型", "Model directory unavailable; showing the configured model") : efforts.length
          ? t("仅本次会话 · 支持思考档位", "This session only · reasoning levels supported")
          : t("仅本次会话 · 思考使用服务默认", "This session only · service-default reasoning")}</small>}
  </div>;
}
