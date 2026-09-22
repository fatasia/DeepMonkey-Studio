import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AiSessionSummary, AiSessionMessage, AiSessionMessageInput } from "@bim-studio/contracts";

interface Session extends AiSessionSummary { owner: string; messages: AiSessionMessage[] }
export class AssistantSessionError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
export class AssistantSessionStore {
  private sessions: Session[] = [];
  private writes = Promise.resolve();
  private sequence = 0;
  private readonly file: string;
  constructor(dataDir: string) { this.file = path.join(dataDir, "assistant-sessions.json"); }
  async init() {
    await mkdir(path.dirname(this.file), { recursive: true });
    try {
      const saved = JSON.parse(await readFile(this.file, "utf8"));
      if (saved.schemaVersion !== 1 || !Array.isArray(saved.sessions)) throw new Error("助手会话存储格式无效");
      this.sessions = saved.sessions;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const now = new Date().toISOString();
    let changed = false;
    for (const session of this.sessions) for (const message of session.messages) if (message.status === "streaming") {
      message.status = "interrupted"; message.updatedAt = now; session.updatedAt = now; changed = true;
    }
    if (changed) await this.persist(this.sessions);
  }
  list(owner: string, project: string, after: string | undefined, limit: number) {
    const list = this.sessions.filter((session) => session.owner === owner && session.projectId === project).reverse();
    const page = paginate(list, after, limit);
    return { items: page.items.map(summary), ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) };
  }
  messages(owner: string, project: string, id: string, after: string | undefined, limit: number) {
    const session = this.require(this.sessions, owner, project, id);
    const page = paginate(session.messages, after, limit);
    return structuredClone({ session: summary(session), messages: page.items, ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) });
  }
  create(owner: string, project: string, id: string, title: string): Promise<AiSessionSummary> {
    return this.mutate((sessions) => {
      const existing = sessions.find((session) => session.id === id);
      if (existing) {
        const found = this.require(sessions, owner, project, id);
        if (found.title !== title) throw new AssistantSessionError(409, "会话 ID 已用于不同标题");
        return summary(found);
      }
      if (sessions.length >= 500 || sessions.filter((session) => session.owner === owner && session.projectId === project).length >= 50) throw new AssistantSessionError(429, "会话数量已达上限（每用户项目 50 个）");
      const now = new Date().toISOString();
      const session: Session = { id, owner, projectId: project, title, createdAt: now, updatedAt: now, messageCount: 0, messages: [] };
      sessions.push(session); return summary(session);
    });
  }
  putMessage(owner: string, project: string, sessionId: string, id: string, input: AiSessionMessageInput): Promise<AiSessionMessage> {
    return this.mutate((sessions) => {
      const session = this.require(sessions, owner, project, sessionId);
      const previous = session.messages.find((message) => message.id === id);
      if (previous) {
        const { id: _id, createdAt: _created, updatedAt: _updated, ...saved } = previous;
        if (JSON.stringify(saved) === JSON.stringify(input)) return previous;
        if (input.sequence <= previous.sequence || previous.status !== "streaming") throw new AssistantSessionError(409, "消息版本冲突或已结束，请读取最新状态");
        if (input.question !== previous.question || input.mode !== previous.mode || input.scope !== previous.scope) throw new AssistantSessionError(409, "消息所属问题和范围不能改变");
      } else if (session.messages.length >= 100) throw new AssistantSessionError(429, "每个会话最多 100 轮问答");
      const now = new Date().toISOString();
      const message: AiSessionMessage = { ...input, id, createdAt: previous?.createdAt ?? now, updatedAt: now };
      if (previous) session.messages[session.messages.indexOf(previous)] = message;
      else session.messages.push(message);
      session.messageCount = session.messages.length; session.updatedAt = now;
      return message;
    });
  }
  private require(sessions: Session[], owner: string, project: string, id: string): Session {
    const session = sessions.find((item) => item.id === id && item.owner === owner && item.projectId === project);
    if (!session) throw new AssistantSessionError(404, "会话不存在");
    return session;
  }
  private mutate<T>(change: (sessions: Session[]) => T): Promise<T> {
    const pending = this.writes.then(async () => {
      const next = structuredClone(this.sessions);
      const result = change(next);
      if (JSON.stringify(next) !== JSON.stringify(this.sessions)) { await this.persist(next); this.sessions = next; }
      return structuredClone(result);
    });
    this.writes = pending.then(() => undefined, () => undefined);
    return pending;
  }
  private async persist(sessions: Session[]) {
    const content = JSON.stringify({ schemaVersion: 1, sessions });
    if (Buffer.byteLength(content) > 20 * 1024 * 1024) throw new AssistantSessionError(429, "助手会话存储已达 20 MiB 上限");
    const temporary = `${this.file}.${process.pid}.${++this.sequence}.tmp`;
    try { await writeFile(temporary, content, "utf8"); await rename(temporary, this.file); }
    catch (error) { await rm(temporary, { force: true }); throw error; }
  }
}
function summary(session: Session): AiSessionSummary {
  const { owner: _owner, messages: _messages, ...publicSession } = session; return publicSession;
}
function paginate<T extends { id: string }>(items: T[], after: string | undefined, limit: number) {
  const index = after ? items.findIndex((item) => item.id === after) : -1;
  if (after && index < 0) throw new AssistantSessionError(400, "分页游标无效");
  const page = items.slice(index + 1, index + 1 + limit);
  return { items: page, ...(index + 1 + limit < items.length && page.length ? { nextCursor: page.at(-1)!.id } : {}) };
}
