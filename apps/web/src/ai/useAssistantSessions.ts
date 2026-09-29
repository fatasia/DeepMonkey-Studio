import { useEffect, useRef, useState } from "react";
import type { AiSessionSummary, AiSessionMessageInput } from "@bim-studio/contracts";
import { api } from "../api";
import type { AssistantConversationItem } from "../components/AiAssistantMessages";
import { AssistantSessionWriter } from "./assistantSessionWriter";

/** K12 跨标签页同步频道：写方广播自己保存的会话，读方标记"在其他窗口有更新"。 */
const SYNC_CHANNEL = "bim-studio:assistant-sessions";
const SYNC_STORAGE_KEY = "bim-studio:assistant-sessions:sync";
interface SessionSyncPayload { tab: string; project: string; scope: string; session: string }
function isVersionConflict(reason: unknown): boolean {
  const candidate = reason as { status?: unknown; body?: { code?: unknown } } | null | undefined;
  if (!candidate || typeof candidate !== "object") return false;
  if (candidate.body && typeof candidate.body === "object" && candidate.body.code === "message-version-conflict") return true;
  return candidate.status === 409;
}

export function useAssistantSessions(projectId: string | undefined, scopeKey: string) {
  const [sessions, setSessions] = useState<AiSessionSummary[]>([]);
  const [sessionId, setSessionId] = useState("");
  const [conversation, setConversation] = useState<AssistantConversationItem[]>([]);
  const [loading, setLoading] = useState(Boolean(projectId));
  const [error, setError] = useState("");
  const [cursor, setCursor] = useState<string>();
  const [authRevision, setAuthRevision] = useState(0);
  // K12：conflict=保存遇到另一标签页写入（409），external=收到其他窗口的保存广播。
  const [conflict, setConflict] = useState(false);
  const [externalSessionId, setExternalSessionId] = useState<string>();
  const generation = useRef(0);
  const identity = useRef("");
  const activeId = useRef("");
  const owner = useRef("");
  const pendingCreate = useRef<{ id: string; title: string } | undefined>(undefined);
  const writers = useRef(new Set<AssistantSessionWriter>());
  const tabId = useRef(crypto.randomUUID());
  const channel = useRef<BroadcastChannel | undefined>(undefined);
  const key = JSON.stringify([projectId, scopeKey, authRevision]);
  identity.current = key;
  const current = (expected: string, version: number) => identity.current === expected && generation.current === version;
  function newSession() {
    pendingCreate.current = undefined;
    generation.current++; activeId.current = ""; setSessionId(""); setConversation([]); setLoading(false); setError(""); setConflict(false); setExternalSessionId(undefined);
  }
  async function select(id: string) {
    if (!projectId) return;
    const expected = key, version = ++generation.current;
    setLoading(true); setError(""); setConflict(false); setExternalSessionId(undefined);
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
    setError(""); setConflict(false); setExternalSessionId(undefined);
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
    setConflict(false); setExternalSessionId(undefined);
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
  // K12 多标签页同步：BroadcastChannel 主通道 + storage 事件兜底，收到其他窗口的保存广播后标记会话为可载入更新。
  useEffect(() => {
    if (!projectId) return;
    const accept = (raw: string) => {
      try {
        const data = JSON.parse(raw) as Partial<SessionSyncPayload>;
        if (!data || data.tab === tabId.current || data.project !== projectId || data.scope !== scopeKey || typeof data.session !== "string") return;
        setExternalSessionId(data.session);
      } catch { /* 无法解析的广播按噪声忽略。 */ }
    };
    const notify = (payload: SessionSyncPayload) => {
      const raw = JSON.stringify(payload);
      try { channel.current?.postMessage(raw); } catch { /* 通道关闭时靠 storage 兜底。 */ }
      try { window.localStorage.setItem(SYNC_STORAGE_KEY, raw); } catch { /* storage 不可用时放弃兜底通道。 */ }
    };
    if (typeof BroadcastChannel === "function") {
      channel.current = new BroadcastChannel(SYNC_CHANNEL);
      channel.current.onmessage = event => accept(String(event.data));
    }
    const onStorage = (event: StorageEvent) => { if (event.key === SYNC_STORAGE_KEY && event.newValue) accept(event.newValue); };
    window.addEventListener("storage", onStorage);
    return () => { channel.current?.close(); channel.current = undefined; window.removeEventListener("storage", onStorage); };
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
    const capturedOwner = user.id, message = crypto.randomUUID(), session = id, project = projectId;
    // K12 条件写版本：writer 每次保存成功后记录服务端返回的 updatedAt，下一拍作为 If-Match 回传防静默覆盖。
    const serverVersion = { current: undefined as string | undefined };
    const writer = new AssistantSessionWriter(async input => {
      if ((await api.me()).id !== capturedOwner) throw new Error("用户已切换，旧会话保存已停止");
      const saved = await api.saveAssistantSessionMessage(project, session, message, input, serverVersion.current);
      if (saved && typeof saved.updatedAt === "string") serverVersion.current = saved.updatedAt;
      notifySessionWritten({ tab: tabId.current, project, scope: scopeKey, session });
      return saved;
    }, reason => {
      if (identity.current !== expected) return;
      if (isVersionConflict(reason)) setConflict(true);
      else setError(`会话保存失败：${reason instanceof Error ? reason.message : String(reason)}`);
    });
    writers.current.add(writer); writer.update(snapshot);
    return { writer, message, isCurrent: () => current(expected, version) };
  }
  function notifySessionWritten(payload: SessionSyncPayload) {
    const raw = JSON.stringify(payload);
    try { channel.current?.postMessage(raw); } catch { /* 通道关闭时靠 storage 兜底。 */ }
    try { window.localStorage.setItem(SYNC_STORAGE_KEY, raw); } catch { /* storage 不可用时放弃兜底通道。 */ }
  }
  async function retrySave() {
    setError("");
    try { await Promise.all([...writers.current].map(writer => writer.flush())); }
    catch (reason) {
      if (isVersionConflict(reason)) setConflict(true);
      else setError(`会话保存失败：${reason instanceof Error ? reason.message : String(reason)}`);
    }
  }
  return { identity: key, sessions, sessionId, conversation, setConversation, loading, error, cursor, conflict, externalSessionId, select, refresh, newSession, begin, retrySave };
}
