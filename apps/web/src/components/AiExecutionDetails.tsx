import type { AiAssistantResponse } from "@bim-studio/contracts";
import { translate as tr, type AppLocale } from "../i18n";

export function AiExecutionDetails({ locale, execution }: { locale: AppLocale; execution: NonNullable<AiAssistantResponse["execution"]> }) {
  const t = (zh: string, en: string) => tr(locale, zh, en);
  const causes: Record<string, string> = { quota: t("主模型额度不足", "Primary quota exhausted"), "rate-limit": t("主模型限流", "Primary rate limit"), server: t("主模型服务异常", "Primary service error"), timeout: t("主模型超时", "Primary timed out"), network: t("主模型连接失败", "Primary connection failed") };
  const reasons: Record<string, string> = {
    "simple-question": t("简单只读问答", "Simple read-only question"), "write-intent": t("含写入/控制意图", "Write or control intent"),
    "planning-or-code": t("规划/分析/编码类", "Planning, analysis or coding"), "multi-step": t("多步骤请求", "Multi-step request"),
    "code-input": t("含代码输入", "Contains code"), "long-question": t("问题较长", "Long question"), "input-risk": t("输入含可疑指令", "Suspicious input"),
    "mode-needs-strong": t("该模式固定用强模型", "This mode always uses the strong model"), "custom-keyword": t("命中自定义规则", "Custom rule matched"),
    "no-fast-match": t("无法确认是简单问答", "Not clearly a simple question"), "no-fast-model": t("未配置小模型", "No fast model configured"), "router-error": t("路由异常，使用默认模型", "Router error; default model used"),
  };
  const route = execution.route;
  return <details className="ai-execution-details" style={{ minWidth: 0, overflowWrap: "anywhere" }}>
    <summary>{t("模型与思考设置", "Model and reasoning settings")}</summary>
    {execution.servedBy === "fallback" && <div>{t("备用模型接管", "Fallback model used")}{execution.failoverCategory ? ` · ${causes[execution.failoverCategory] ?? t("主模型不可用", "Primary unavailable")}` : ""}</div>}
    {route && <div>{t("自动路由", "Auto routing")}: {route.tier === "fast" ? t("小模型", "Fast model") : t("强模型", "Strong model")} · {route.model} · {reasons[route.reason] ?? route.reason}
      {route.fellBack ? ` · ${t("小模型失败，已改用强模型", "fast model failed; retried on the strong model")}` : ""}</div>}
    <div>{t("请求模型", "Requested model")}: {execution.requestedModel}</div>
    <div>{t("服务商返回模型", "Provider-reported model")}: {execution.reportedModel ?? t("未返回", "Not reported")}</div>
    <div>{t("发送的思考档位", "Reasoning effort sent")}: {execution.reasoningEffortSent ?? t("使用服务商默认值", "Provider default")}</div>
    <div>{t("服务商返回档位", "Provider-reported effort")}: {execution.reasoningEffortReported ?? t("未返回", "Not reported")}</div>
  </details>;
}
