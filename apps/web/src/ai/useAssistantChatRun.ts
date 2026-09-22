import { useEffect, useRef, useState } from "react";
import type { SceneDashboardState } from "@bim-studio/contracts";
import { api, type AssistantMode } from "../api";
import type { BimAssistantPreparedContext } from "../bimAssistant";
import type { AppLocale } from "../i18n";
import type { AssistantSessionOptions } from "../apiClients/aiApi";
import type { AssistantContextSource } from "./assistantReliability";
import { runAssistantRequest } from "./runAssistantRequest";
import type { useAssistantSessions } from "./useAssistantSessions";
import type { AssistantConversationItem } from "../components/AiAssistantMessages";

export function useAssistantChatRun(input: {
  sessions: ReturnType<typeof useAssistantSessions>; projectId: string | undefined; requestScope: string; scopeLabel: string; scopeId: string | undefined;
  question: string; setQuestion: (value: string) => void; mode: AssistantMode; locale: AppLocale; context: unknown; platformContext: unknown;
  sources: AssistantContextSource[]; sessionOptions: AssistantSessionOptions; onBegin: () => void;
  prepareBim: ((question: string) => Promise<BimAssistantPreparedContext>) | undefined;
}) {
  const [answer, setAnswer] = useState(""); const [busy, setBusy] = useState(false);
  const [execution, setExecution] = useState<AssistantConversationItem["execution"]>();
  const [stopped, setStopped] = useState(false); const [error, setError] = useState<string>();
  const [lastPrompt, setLastPrompt] = useState(""); const [lastScope, setLastScope] = useState("");
  const [dashboard, setDashboard] = useState<SceneDashboardState>();
  const [bimEvidence, setBimEvidence] = useState<BimAssistantPreparedContext>();
  const requestAbort = useRef<AbortController | undefined>(undefined);
  const activeStop = useRef<(() => Promise<void>) | undefined>(undefined);
  const partialTurn = useRef<{ item: AssistantConversationItem; isCurrent: () => boolean } | undefined>(undefined);
  const currentScope = useRef(input.requestScope); currentScope.current = input.requestScope;
  async function cancelRequest() {
    requestAbort.current?.abort();
    const stop = activeStop.current; activeStop.current = undefined;
    const saving = stop?.();
    requestAbort.current = undefined; setBusy(false); await saving;
  }
  useEffect(() => () => { void cancelRequest(); }, [input.requestScope]);
  async function ask(retryPrompt?: string) {
    const prompt = (retryPrompt ?? input.question).trim();
    if (!prompt || requestAbort.current || input.sessions.loading) return;
    const previousPartial = partialTurn.current;
    partialTurn.current = undefined;
    const recentConversation = previousPartial?.isCurrent()
      ? [...input.sessions.conversation, previousPartial.item] : input.sessions.conversation;
    if (previousPartial?.isCurrent()) input.sessions.setConversation(recentConversation);
    const controller = new AbortController(); requestAbort.current = controller;
    const scope = input.requestScope;
    const isCurrent = () => requestAbort.current === controller && !controller.signal.aborted && currentScope.current === scope;
    setLastPrompt(prompt); setLastScope(input.scopeLabel); setStopped(false); input.onBegin();
    if (!retryPrompt) input.setQuestion("");
    setBusy(true); setError(undefined); setDashboard(undefined); setBimEvidence(undefined); setAnswer("");
    setExecution(undefined);
    let streamed = "";
    let lastExecution: AssistantConversationItem["execution"];
    let saved: Awaited<ReturnType<typeof input.sessions.begin>>;
    const snapshot = { question: prompt, answer: "", mode: input.mode, status: "streaming" as const, ...(input.scopeId ? { scope: input.scopeId } : {}) };
    let ended = false;
    async function finish(status: "completed" | "stopped" | "failed", model?: string, execution = lastExecution,
      reliability?: AssistantConversationItem["reliability"]) {
      if (!saved || ended) return;
      ended = true;
      if (status !== "completed" && saved.isCurrent() && requestAbort.current === controller && currentScope.current === scope) {
        partialTurn.current = { isCurrent: saved.isCurrent, item: { id: saved.message, question: prompt, answer: streamed,
          mode: input.mode, scope: input.scopeLabel, status, ...(execution ? { execution } : {}) } };
      }
      saved.writer.update({ ...snapshot, answer: streamed, status, ...(model ? { model } : {}), ...(execution ? { execution } : {}), ...(reliability ? { reliability } : {}) });
      try { await saved.writer.flush(); } catch { /* Session hook retains the failed snapshot and exposes retry. */ }
    }
    try {
      saved = await input.sessions.begin(snapshot);
      await saved?.writer.flush();
      if (!isCurrent()) { await finish("stopped"); return; }
      activeStop.current = () => finish("stopped");
      const result = await runAssistantRequest({ client: api, mode: input.mode, prompt, locale: input.locale, context: input.context,
        platformContext: input.platformContext, sources: input.sources, sessionOptions: input.sessionOptions,
        ...(input.projectId ? { projectId: input.projectId } : {}), ...(input.prepareBim ? { prepareBim: input.prepareBim } : {}),
        recentConversation: recentConversation.slice(-6).map(({ mode, question, answer, scope }) => ({ mode, question, answer, ...(scope ? { scope } : {}) })),
        signal: controller.signal,
        onPrepared: prepared => { if (isCurrent()) setBimEvidence(prepared); },
        onExecution: execution => { if (isCurrent()) { lastExecution = execution; setExecution(execution); saved?.writer.update({ ...snapshot, answer: streamed, ...(execution ? { execution } : {}) }); } },
        onDelta: delta => { if (isCurrent()) { streamed += delta; setAnswer(streamed); saved?.writer.update({ ...snapshot, answer: streamed, ...(lastExecution ? { execution: lastExecution } : {}) }); } },
      });
      if (!isCurrent()) return;
      streamed = result.text;
      await finish("completed", result.model, result.execution, result.reliability);
      if (!isCurrent()) return;
      setAnswer(result.text); setDashboard(result.dashboard); setBimEvidence(result.prepared);
      input.sessions.setConversation(previous => [...previous, { id: saved?.message ?? crypto.randomUUID(), mode: input.mode,
        question: prompt, answer: result.text, reliability: result.reliability, scope: input.scopeLabel, status: "completed",
        ...(result.execution ? { execution: result.execution } : {}),
        ...(result.model ? { model: result.model } : {}) }]);
    } catch (reason) {
      await finish(controller.signal.aborted ? "stopped" : "failed");
      if (isCurrent()) setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (requestAbort.current === controller) { requestAbort.current = undefined; activeStop.current = undefined; setBusy(false); }
    }
  }
  return { answer, setAnswer, execution, busy, stopped, setStopped, error, setError, lastPrompt, setLastPrompt, lastScope,
    dashboard, setDashboard, bimEvidence, setBimEvidence, requestAbort, cancelRequest, ask };
}
