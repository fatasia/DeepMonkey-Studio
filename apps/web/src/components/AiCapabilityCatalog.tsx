import { Boxes, LoaderCircle, RefreshCw, ShieldCheck } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { api, type CapabilityDescriptor } from "../api";
import {
  capabilityWorkspaceTask,
  capabilityWritePolicy,
  summarizeCapabilityCatalog,
  type AiWorkspaceTask,
} from "../ai/capabilityCatalog";
import { translate as tr, type AppLocale } from "../i18n";

interface AiCapabilityCatalogProps {
  locale: AppLocale;
  canOpenTask?: (task: AiWorkspaceTask) => boolean;
  onOpenTask?: (task: AiWorkspaceTask) => void;
  /** T9（审计 §二 2.4）：点示例问题直接向助手提问（"能为我做什么"映射）；缺省时示例只展示不可点。 */
  onAskExample?: (question: string) => void;
  /** T9：busy 期间示例提问禁用。 */
  askDisabled?: boolean;
}

/**
 * T9：能力 → 示例问题的通用映射。能力目录刻意不维护领域白名单（capabilityCatalog 注），
 * 因此示例问题按 id 命名空间与写入策略派生，不虚构每个能力的私有语义：
 * 问句让模型自己决定是否调用该能力，回答仍受证据链约束。
 */
export function capabilityExampleQuestion(capability: Pick<CapabilityDescriptor, "id" | "label" | "kind">, locale: AppLocale): string {
  const t = (zh: string, en: string) => tr(locale, zh, en);
  if (capability.id.startsWith("data.")) {
    return t(`用「${capability.label}」查询当前项目的数据，并给出证据来源`, `Use "${capability.label}" to query this project's data and cite the evidence`);
  }
  if (capability.kind === "action") {
    return t(`「${capability.label}」会改变状态——先说明它的参数、影响范围，再等我确认`, `"${capability.label}" changes state; explain its parameters and impact first, then wait for my confirmation`);
  }
  return t(`用「${capability.label}」分析当前工作区，结论要给出证据`, `Use "${capability.label}" to analyze this workspace; back the conclusion with evidence`);
}

/** 展示插件运行时真实注册的能力，避免页面文案与部署状态脱节。 */
export function AiCapabilityCatalog({ locale, canOpenTask, onOpenTask, onAskExample, askDisabled }: AiCapabilityCatalogProps) {
  const [capabilities, setCapabilities] = useState<CapabilityDescriptor[]>([]);
  const [status, setStatus] = useState<"loading" | "ready" | "unavailable">(
    "loading",
  );
  const [reloadToken, setReloadToken] = useState(0);
  const summary = useMemo(
    () => summarizeCapabilityCatalog(capabilities),
    [capabilities],
  );
  const t = (zh: string, en: string) => tr(locale, zh, en);

  useEffect(() => {
    let cancelled = false;
    let activeController: AbortController | undefined;
    const discover = async () => {
      for (let attempt = 0; attempt < 2 && !cancelled; attempt += 1) {
        activeController = new AbortController();
        // 能力目录只影响入口展示，不能因代理或弱网异常让整个 AI 面板永久停在加载态。
        const timeout = window.setTimeout(() => activeController?.abort(), 5_000);
        try {
          const { capabilities: discovered } = await api.listCapabilities(activeController.signal);
          if (cancelled) return;
          setCapabilities(discovered);
          setStatus("ready");
          return;
        } catch {
          if (attempt === 0) await new Promise((resolveRetry) => window.setTimeout(resolveRetry, 250));
        } finally {
          window.clearTimeout(timeout);
        }
      }
      if (!cancelled) setStatus("unavailable");
    };
    void discover();
    return () => {
      cancelled = true;
      activeController?.abort();
    };
  }, [reloadToken]);

  if (status === "loading") {
    return (
      <section className="ai-capability-catalog is-loading">
        <LoaderCircle className="spin" size={14} />
        <span>{t("正在发现插件能力", "Discovering plugin capabilities")}</span>
      </section>
    );
  }
  if (status === "unavailable") {
    return (
      <section className="ai-capability-catalog is-unavailable">
        <Boxes size={14} />
        <span>{t("能力目录暂不可用；不会显示或执行未知能力", "Capability catalog unavailable; unknown capabilities stay disabled")}</span>
        <button
          type="button"
          onClick={() => {
            setStatus("loading");
            setReloadToken((value) => value + 1);
          }}
        >
          <RefreshCw size={12} />
          {t("重试", "Retry")}
        </button>
      </section>
    );
  }

  return (
    <section className="ai-capability-catalog">
      <header>
        <span>
          <Boxes size={14} />
          {t("当前可用智能任务", "Available intelligent tasks")}
        </span>
        <strong>{summary.total}</strong>
      </header>
      <p className="ai-capability-policy-summary">
        <ShieldCheck size={11} />
        {t(
          `${summary.readOnlyCount} 项只读直接执行 · ${summary.actionCount} 项写入需确认`,
          `${summary.readOnlyCount} read-only · ${summary.actionCount} require confirmation`,
        )}
      </p>
      <div>
        {summary.visible.map((capability) => {
          const task = capabilityWorkspaceTask(capability.id);
          const policy = capabilityWritePolicy(capability.kind);
          const content = (
            <>
              <strong>{capability.label}</strong>
              <small>{policy === "read-only" ? t("只读", "Read") : t("确认", "Confirm")}</small>
            </>
          );
          return task && onOpenTask && (canOpenTask?.(task) ?? true) ? (
            <button key={capability.id} title={`${capability.label} · ${capability.id}`} onClick={() => onOpenTask(task)}>
              {content}
            </button>
          ) : (
            <span key={capability.id} title={`${capability.label} · ${capability.id}`}>
              {content}
            </span>
          );
        })}
        {summary.hiddenCount > 0 && <span>+{summary.hiddenCount}</span>}
      </div>
      {summary.visible.length > 0 && (
        <AiCapabilityExamples locale={locale} capabilities={summary.visible}
          {...(onAskExample ? { onAskExample } : {})} {...(askDisabled ? { disabled: true } : {})} />
      )}
      <small>
        {t(
          "由插件按需装载；可点击的任务会进入受控工作台",
          "Loaded on demand; actionable tasks open a controlled workspace",
        )}
      </small>
    </section>
  );
}

/** T9：能力目录的"能为我做什么"示例问题区（纯视图，可静态渲染测试）。 */
export function AiCapabilityExamples({ locale, capabilities, onAskExample, disabled }: {
  locale: AppLocale;
  capabilities: ReadonlyArray<Pick<CapabilityDescriptor, "id" | "label" | "kind">>;
  onAskExample?: (question: string) => void;
  disabled?: boolean;
}) {
  const t = (zh: string, en: string) => tr(locale, zh, en);
  return (
    <div className="ai-capability-examples" aria-label={t("能力示例问题", "Capability example questions")}>
      <small>{t("能为我做什么", "What can it do for me")}</small>
      {capabilities.slice(0, 4).map((capability) => (
        <button key={`example-${capability.id}`} type="button"
          disabled={disabled || !onAskExample}
          title={capabilityExampleQuestion(capability, locale)}
          onClick={() => onAskExample?.(capabilityExampleQuestion(capability, locale))}>
          {capabilityExampleQuestion(capability, locale)}
        </button>
      ))}
    </div>
  );
}
