import { useEffect, useRef, useState } from "react";
import type { AiSessionSummary, AiSessionMessageInput } from "@bim-studio/contracts";
import { api } from "../api";
import type { AssistantConversationItem } from "../components/AiAssistantMessages";
import { AssistantSessionWriter } from "./assistantSessionWriter";

export function useAssistantSessions(projectId: string | undefined, scopeKey: string) {
  const [sessions, setSessions] = useState<AiSessionSummary[]>([]);
  const [sessionId, setSessionId] = useState("");
  const [conversation, setConversation] = useState<AssistantConversationItem[]>([]);
  const [loading, setLoading] = useState(Boolean(projectId));
  const [error, setError] = useState("");
  const [cursor, setCursor] = useState<string>();
  const [authRevision, setAuthRevision] = useState(0);
  const generation = useRef(0);
  const identity = useRef("");
  const activeId = useRef("");
  const owner = useRef("");
  const pendingCreate = useRef<{ id: string; title: string } | undefined>(undefined);
  const writers = useRef(new Set<AssistantSessionWriter>());
  const key = JSON.stringify([projectId, scopeKey, authRevision]);
  identity.current = key;
  const current = (expected: string, version: number) => identity.current === expected && generation.current === version;
  function newSession() {
    pendingCreate.current = undefined;
    generation.current++; activeId.current = ""; setSessionId(""); setConversation([]); setLoading(false); setError("");
  }
  async function select(id: string) {
    if (!projectId) return;
    const expected = key, version = ++generation.current;
    setLoading(true); setError("");
    try {
      let after: string | undefined; const messages: AssistantConversationItem[] = [];
      do {
        const page = await api.getAssistantSessionMessages(projectId, id, after);
        if (!current(expected, version)) return;
        messages.push(...page.messages.map(message => ({ id: message.id, mode: message.mode, question: message.question,
          answer: message.answer, status: message.status, ...(message.model ? { model: message.model } : {}), ...(message.execution ? { execution: message.execution } : {}),
          ...(message.scope ? { scope: message.scope } : {}), ...(message.reliability ? { reliability: message.reliability } : {}) })));
        after = page.nextCursor;
      } while (after);
      activeId.current = id; setSessionId(id); setConversation(messages);
    } catch (reason) { if (current(expected, version)) setError(String(reason)); }
    finally { if (current(expected, version)) setLoading(false); }
  }
  async function refresh(more = false) {
    if (!projectId) return;
    const expected = key, version = generation.current;
    setError("");
    try {
      const user = await api.me();
      if (!current(expected, version)) return;
      owner.current = user.id;
      const page = await api.listAssistantSessions(projectId, more ? cursor : undefined);
      if (!current(expected, version)) return;
      setSessions(previous => more ? [...previous, ...page.items.filter(item => !previous.some(old => old.id === item.id))] : page.items);
      setCursor(page.nextCursor);
      if (!more && activeId.current) await select(activeId.current);
      else if (!more && page.items[0]) await select(page.items[0].id);
    } catch (reason) { if (current(expected, version)) setError(String(reason)); }
  }
  useEffect(() => {
    const changed = () => { generation.current++; owner.current = ""; setConversation([]); setAuthRevision(value => value + 1); };
    window.addEventListener("bim-auth-changed", changed);
    return () => window.removeEventListener("bim-auth-changed", changed);
  }, []);
  useEffect(() => {
    const expected = key, version = ++generation.current;
    activeId.current = ""; pendingCreate.current = undefined; writers.current.clear(); setCursor(undefined); setSessionId(""); setConversation([]); setSessions([]); setError(""); owner.current = "";
    if (!projectId) { setLoading(false); return; }
    setLoading(true);
    void (async () => {
      try {
        const user = await api.me();
        if (!current(expected, version)) return;
        owner.current = user.id;
        const page = await api.listAssistantSessions(projectId);
        if (!current(expected, version)) return;
        setSessions(page.items); setCursor(page.nextCursor);
        if (page.items[0]) await select(page.items[0].id);
        else setLoading(false);
      } catch (reason) { if (current(expected, version)) { setError(String(reason)); setLoading(false); } }
    })();
    return () => { generation.current++; };
  }, [key]);
  async function begin(snapshot: Omit<AiSessionMessageInput, "sequence">) {
    if (!projectId) return undefined;
    const expected = key, version = generation.current;
    const user = await api.me();
    if (!current(expected, version) || user.id !== owner.current) throw new Error("用户或项目已切换，请重新载入会话");
    let id = activeId.current;
    if (!id) {
      pendingCreate.current ??= { id: crypto.randomUUID(), title: snapshot.question.slice(0, 120) };
      id = pendingCreate.current.id;
      const created = await api.createAssistantSession(projectId, id, pendingCreate.current.title);
      if (!current(expected, version)) throw new Error("会话已切换");
      activeId.current = id; setSessionId(id); setSessions(previous => [created, ...previous]);
      pendingCreate.current = undefined;
    }
    const capturedOwner = user.id, message = crypto.randomUUID(), session = id;
    const writer = new AssistantSessionWriter(async input => {
      if ((await api.me()).id !== capturedOwner) throw new Error("用户已切换，旧会话保存已停止");
      return api.saveAssistantSessionMessage(projectId, session, message, input);
    }, reason => { if (identity.current === expected) setError(`会话保存失败：${String(reason)}`); });
    writers.current.add(writer); writer.update(snapshot);
    return { writer, message, isCurrent: () => current(expected, version) };
  }
  async function retrySave() {
    setError("");
    try { await Promise.all([...writers.current].map(writer => writer.flush())); }
    catch (reason) { setError(`会话保存失败：${String(reason)}`); }
  }
  return { identity: key, sessions, sessionId, conversation, setConversation, loading, error, cursor, select, refresh, newSession, begin, retrySave };
}
