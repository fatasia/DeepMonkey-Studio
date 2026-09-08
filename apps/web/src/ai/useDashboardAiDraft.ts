import { useEffect, useRef, useState } from "react";
import type { ApplicationDocument, DashboardPageDocument, DataDatasetRecord } from "@bim-studio/contracts";
import type { StudioCommand } from "@bim-studio/studio-core";
import { api } from "../api";
import { translate as tr, type AppLocale } from "../i18n";
import { dashboardDraftPageContext, validateDashboardDraft } from "./dashboardDraft";

type Proposal = ReturnType<typeof validateDashboardDraft> & { raw: unknown; application: ApplicationDocument; page: DashboardPageDocument };
interface Context { locale: AppLocale; application: ApplicationDocument; page: DashboardPageDocument; canWrite: boolean; onCommand(command: StudioCommand): void; }

export function dashboardDraftBaseline(context: Pick<Context, "application" | "page">) {
  return `${context.application.metadata.projectId}:${context.application.metadata.id}:${context.application.metadata.revision}:${JSON.stringify(context.page)}`;
}

export function dashboardDraftStreamText(content: string): string {
  const match = /"text"\s*:\s*"((?:\\.|[^"\\])*)/.exec(content);
  if (!match) return "";
  try { return JSON.parse(`"${match[1]}"`) as string; } catch { return ""; }
}

export function dashboardDraftFailure(locale: AppLocale, reason: unknown) {
  return locale === "zh-CN" ? reason instanceof Error ? reason.message : String(reason)
    : "Unable to apply this draft. Check the current page and dataset fields, then generate a new draft.";
}

/** 一次会话绑定页面；请求和应用各自校验当前基线，保存仍走工作区原有按钮。 */
export function useDashboardAiDraft(context: Context) {
  const t = (zh: string, en: string) => tr(context.locale, zh, en);
  const failure = (reason: unknown) => dashboardDraftFailure(context.locale, reason);
  const latest = useRef(context); latest.current = context;
  const active = useRef(true), request = useRef<AbortController | undefined>(undefined);
  const [phase, setPhase] = useState<"catalog" | "generate" | "apply" | undefined>("catalog");
  const [datasets, setDatasets] = useState<DataDatasetRecord[]>([]);
  const [catalogReady, setCatalogReady] = useState(false);
  const [error, setError] = useState("");
  const [answer, setAnswer] = useState("");
  const [notice, setNotice] = useState("");
  const [proposal, setProposal] = useState<Proposal>();
  const conversation = useRef<Array<{ question: string; answer: string }>>([]);
  const projectId = context.application.metadata.projectId;
  const stale = Boolean(proposal && dashboardDraftBaseline(proposal) !== dashboardDraftBaseline(context));
  useEffect(() => {
    active.current = true; void loadCatalog();
    return () => { active.current = false; request.current?.abort(); request.current = undefined; };
  }, [projectId]);

  function current(controller: AbortController) { return active.current && request.current === controller && !controller.signal.aborted; }
  function finish(controller: AbortController) { if (current(controller)) { request.current = undefined; setPhase(undefined); } }
  function cancel() { request.current?.abort(); request.current = undefined; setPhase(undefined); setProposal(undefined); setNotice(t("已停止，页面未修改。", "Stopped. The page is unchanged.")); }

  async function loadCatalog() {
    if (request.current) return;
    const controller = new AbortController(); request.current = controller; setPhase("catalog"); setError("");
    try {
      const values = await api.listDatasets(projectId);
      if (!current(controller)) return;
      setDatasets(values); setCatalogReady(true);
    } catch (reason) { if (current(controller)) setError(failure(reason)); }
    finally { finish(controller); }
  }

  async function generate(question: string) {
    if (request.current || !latest.current.canWrite || !catalogReady || !question.trim()) return;
    const baseline = latest.current;
    const stamp = dashboardDraftBaseline(baseline);
    const controller = new AbortController(); request.current = controller;
    setPhase("generate"); setError(""); setAnswer(""); setNotice(""); setProposal(undefined);
    try {
      let streamed = "";
      const result = await api.streamAssistant("dashboard", question.trim(), {
        workspace: { dashboardDraftVersion: 1, projectId, applicationId: baseline.application.metadata.id,
          page: dashboardDraftPageContext(baseline.page), datasets: datasets.map(dataset => ({ id: dataset.id, name: dataset.name, fields: dataset.fields })) },
        recentConversation: conversation.current.slice(-4),
      }, delta => { if (current(controller)) { streamed += delta; setAnswer(dashboardDraftStreamText(streamed)); } }, { projectId, signal: controller.signal });
      if (!current(controller)) return;
      if (!latest.current.canWrite || stamp !== dashboardDraftBaseline(latest.current)) throw new Error(t("页面已变化，请基于当前页面重新生成草案。", "The page changed. Generate a new draft from the current page."));
      const validated = validateDashboardDraft(result.dashboardPageDraft, baseline.application, baseline.page, datasets);
      setAnswer(result.text);
      setProposal({ ...validated, raw: result.dashboardPageDraft, application: baseline.application, page: baseline.page });
      if (!validated.command) setNotice(t("没有可应用的变更，页面保持不变。", "No changes to apply. The page is unchanged."));
      conversation.current = [...conversation.current, { question, answer: result.text }].slice(-4);
    } catch (reason) { if (current(controller)) setError(failure(reason)); }
    finally { finish(controller); }
  }

  async function apply() {
    if (request.current || !proposal?.command || !latest.current.canWrite) return;
    if (stale) { setError(t("页面已变化，请重新生成草案。", "The page changed. Generate a new draft.")); return; }
    const controller = new AbortController(); request.current = controller; setPhase("apply"); setError("");
    try {
      // 确认时重新读取目录，防止生成后已删除的数据集/字段被旧目录放行。
      const currentDatasets = await api.listDatasets(projectId);
      if (!current(controller)) return;
      if (!latest.current.canWrite || dashboardDraftBaseline(proposal) !== dashboardDraftBaseline(latest.current)) throw new Error(t("页面或权限已变化，请重新生成草案。", "The page or permissions changed. Generate a new draft."));
      const validated = validateDashboardDraft(proposal.raw, latest.current.application, latest.current.page, currentDatasets);
      if (!validated.command) throw new Error(t("没有可应用的变更。", "No changes to apply."));
      latest.current.onCommand(validated.command);
      setDatasets(currentDatasets); setProposal(undefined); setNotice(t("已应用，可撤销；请检查后保存。", "Applied. You can undo; review the page before saving."));
    } catch (reason) { if (current(controller)) setError(failure(reason)); }
    finally { finish(controller); }
  }
  return { phase, catalogReady, error, answer, notice, proposal, stale, generate, apply, cancel, loadCatalog,
    discard: () => { setProposal(undefined); setNotice(t("草案已取消，页面未修改。", "Draft discarded. The page is unchanged.")); } };
}
