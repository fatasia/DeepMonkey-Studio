import { Activity, Box, ChevronDown, CircleAlert, CircleCheck, Database, FileCode2, Layers3 } from "lucide-react";
import type { AssistantMode } from "../api";
import {
  assistantContextReadiness,
  assistantWorkspaceTarget,
  type AssistantContextSource,
} from "../ai/assistantReliability";
import { translate as tr, type AppLocale } from "../i18n";

interface AiContextDisclosureProps {
  locale: AppLocale;
  mode: AssistantMode;
  context: unknown;
  sources: AssistantContextSource[];
  loading: boolean;
}

/** 让用户在发送前看见本次请求的对象身份与数据边界。 */
export function AiContextDisclosure({ locale, mode, context, sources, loading }: AiContextDisclosureProps) {
  const target = assistantWorkspaceTarget(context);
  const readiness = assistantContextReadiness(sources);
  const t = (zh: string, en: string) => tr(locale, zh, en);
  const scope = [target.scene?.name ?? target.scene?.id, target.script?.name ?? target.script?.id,
    target.selected?.name ?? target.selected?.id].filter(Boolean).join(" · ")
    || target.project?.name || target.project?.id || t("全平台", "Platform");
  const targetItems = [
    target.project?.name ? { icon: Database, label: t("项目", "Project"), value: target.project.name } : undefined,
    target.scene?.name ? { icon: Layers3, label: t("场景", "Scene"), value: target.scene.name } : undefined,
    target.selected?.name
      ? {
          icon: Box,
          label: t("当前对象", "Selected object"),
          value: `${target.selected.name}${target.selected.kind ? ` · ${target.selected.kind}` : ""}`,
        }
      : undefined,
    target.script?.name
      ? { icon: FileCode2, label: t("脚本", "Script"), value: `${target.script.name}${target.script.language ? ` · ${target.script.language}` : ""}` }
      : undefined,
    target.simulation?.name
      ? { icon: Activity, label: t("仿真任务", "Simulation"), value: `${target.simulation.name}${target.simulation.status ? ` · ${target.simulation.status}` : ""}` }
      : undefined,
  ].filter(Boolean) as Array<{ icon: typeof Box; label: string; value: string }>;

  return (
    <details className="ai-context-disclosure">
      <summary>
        <span>
          <Database size={13} />
          <strong title={`${t("本次读取范围", "Context used for this request")} · ${scope}`}>{scope}</strong>
        </span>
        <span className={loading ? "loading" : readiness.unavailable > 0 ? "partial" : "ready"}>
          {loading
            ? t("读取中", "Loading")
            : t(`${readiness.ready}/${readiness.total} 个来源就绪`, `${readiness.ready}/${readiness.total} sources ready`)}
          <ChevronDown size={12} />
        </span>
      </summary>
      <div className="ai-context-disclosure-body">
        {targetItems.length > 0 && (
          <div className="ai-context-targets">
            {targetItems.map(({ icon: Icon, label, value }) => (
              <span key={label}>
                <Icon size={12} />
                <small>{label}</small>
                <strong title={value}>{value}</strong>
              </span>
            ))}
          </div>
        )}
        <div className="ai-context-source-list">
          {sources.map((source) => {
            const StatusIcon = source.state === "ready" ? CircleCheck : CircleAlert;
            return (
              <span
                className={source.state}
                key={source.id}
                title={source.detail ?? (source.state === "unavailable" ? t("读取失败，本次回答不会使用该来源", "Read failed; this source will not be used") : undefined)}
              >
                <StatusIcon size={12} />
                <strong>{source.label}</strong>
                {source.count !== undefined && <small>{source.count}</small>}
              </span>
            );
          })}
          {!loading && sources.length === 0 && <small>{t("没有可读取的项目来源", "No project sources are available")}</small>}
        </div>
        <p>
          {t(
            `当前为${mode === "sql" ? "受控查询" : "项目上下文快照"}；快照只是模型输入，只有带 Trace 的 Capability 结果才是已执行事实。未提供的数据不会由 AI 自动补全。`,
            `This is a ${mode === "sql" ? "controlled query" : "project context snapshot"}. A snapshot is only model input; only a traced Capability result is executed evidence. Missing data is not inferred.`,
          )}
        </p>
      </div>
    </details>
  );
}
