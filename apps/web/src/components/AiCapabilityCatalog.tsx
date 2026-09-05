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
}

/** 展示插件运行时真实注册的能力，避免页面文案与部署状态脱节。 */
export function AiCapabilityCatalog({ locale, canOpenTask, onOpenTask }: AiCapabilityCatalogProps) {
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
      <small>
        {t(
          "由插件按需装载；可点击的任务会进入受控工作台",
          "Loaded on demand; actionable tasks open a controlled workspace",
        )}
      </small>
    </section>
  );
}
