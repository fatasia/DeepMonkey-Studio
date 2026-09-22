import type { AiAssistantResponse } from "@bim-studio/contracts";
import { translate as tr, type AppLocale } from "../i18n";

export function AiExecutionDetails({ locale, execution }: { locale: AppLocale; execution: NonNullable<AiAssistantResponse["execution"]> }) {
  const t = (zh: string, en: string) => tr(locale, zh, en);
  const causes: Record<string, string> = { quota: t("主模型额度不足", "Primary quota exhausted"), "rate-limit": t("主模型限流", "Primary rate limit"), server: t("主模型服务异常", "Primary service error"), timeout: t("主模型超时", "Primary timed out"), network: t("主模型连接失败", "Primary connection failed") };
  return <details className="ai-execution-details" style={{ minWidth: 0, overflowWrap: "anywhere" }}>
    <summary>{t("模型与思考设置", "Model and reasoning settings")}</summary>
    {execution.servedBy === "fallback" && <div>{t("备用模型接管", "Fallback model used")}{execution.failoverCategory ? ` · ${causes[execution.failoverCategory] ?? t("主模型不可用", "Primary unavailable")}` : ""}</div>}
    <div>{t("请求模型", "Requested model")}: {execution.requestedModel}</div>
    <div>{t("服务商返回模型", "Provider-reported model")}: {execution.reportedModel ?? t("未返回", "Not reported")}</div>
    <div>{t("发送的思考档位", "Reasoning effort sent")}: {execution.reasoningEffortSent ?? t("使用服务商默认值", "Provider default")}</div>
    <div>{t("服务商返回档位", "Provider-reported effort")}: {execution.reasoningEffortReported ?? t("未返回", "Not reported")}</div>
  </details>;
}
