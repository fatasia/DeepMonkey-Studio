import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({ cursor: 0, cells: [] as unknown[], effects: [] as Array<() => void>, cleanups: [] as Array<(() => void) | undefined>,
  me: vi.fn(), list: vi.fn(), messages: vi.fn(), create: vi.fn(), save: vi.fn() }));
vi.mock("../api", () => ({ api: { me: h.me, listAssistantSessions: h.list, getAssistantSessionMessages: h.messages, createAssistantSession: h.create, saveAssistantSessionMessage: h.save } }));
vi.mock("react", () => ({
  useRef: (initial: unknown) => { const slot = h.cursor++; return h.cells[slot] ??= { current: initial }; },
  useState: (initial: unknown) => { const slot = h.cursor++; if (!(slot in h.cells)) h.cells[slot] = initial;
    return [h.cells[slot], (value: unknown) => { h.cells[slot] = typeof value === "function" ? value(h.cells[slot]) : value; }]; },
  useEffect: (effect: () => (() => void) | void, deps: unknown[]) => {
    const slot = h.cursor++, previous = h.cells[slot] as unknown[] | undefined;
    if (!previous || previous.some((value, index) => value !== deps[index])) {
      h.cells[slot] = deps; h.effects.push(() => { h.cleanups[slot]?.(); h.cleanups[slot] = effect() || undefined; });
    }
  },
}));
import { useAssistantSessions } from "./useAssistantSessions";
const session = { id: "s", title: "会话", messageCount: 2 };
const channels: Array<{ onmessage: ((event: { data: string }) => void) | null }> = [];
function render(project = "p", scope = "scene") { h.cursor = 0; const result = useAssistantSessions(project, scope); h.effects.splice(0).forEach(effect => effect()); return result; }
async function flush() { for (let index = 0; index < 30; index++) await Promise.resolve(); }
beforeEach(() => {
  h.cells = []; h.effects = []; h.cleanups = []; channels.length = 0; vi.resetAllMocks(); vi.stubGlobal("window", new EventTarget());
  h.me.mockResolvedValue({ id: "u1" }); h.list.mockResolvedValue({ items: [session] }); h.messages.mockResolvedValue({ messages: [], session });
});
afterEach(() => { h.cleanups.forEach(cleanup => cleanup?.()); vi.unstubAllGlobals(); });
describe("assistant session restoration", () => {
  it("loads all message pages with terminal states without fabricating stored evidence or object names", async () => {
    h.messages.mockResolvedValueOnce({ session, messages: [{ id: "m1", mode: "scene", question: "问", answer: "局部", status: "stopped", scope: "secret-id",
      reliability: { grade: "limited", contextTrust: "server-evidence", evidenceCount: 0, inputRisk: "low", writePolicy: "read-only", warnings: ["服务回退"], sourceLabels: ["场景"] } }], nextCursor: "m1" })
      .mockResolvedValueOnce({ session, messages: [{ id: "m2", mode: "scene", question: "问2", answer: "中断文字", status: "interrupted" }] });
    render(); await flush(); const state = render();
    expect(h.messages).toHaveBeenLastCalledWith("p", "s", "m1");
    expect(state.conversation.map(item => item.status)).toEqual(["stopped", "interrupted"]);
    expect(state.conversation[0]!.reliability).toMatchObject({ grade: "limited", warnings: ["服务回退"] });
    expect(state.conversation[0]).toHaveProperty("scope", "secret-id");
    expect(state.loading).toBe(false);
  });
  it("ignores old-project loads and a cancelled load after choosing a new conversation", async () => {
    let complete!: (page: unknown) => void;
    h.list.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
    render("old"); await flush(); render("new"); await flush();
    render("new").newSession();
    complete({ items: [{ id: "private-old", title: "旧用户内容" }] }); await flush();
    const state = render("new");
    expect(state.sessionId).toBe(""); expect(state.conversation).toEqual([]);
    expect(state.sessions.some(item => item.id === "private-old")).toBe(false);
  });
  it("refuses saving with a changed authenticated owner", async () => {
    render(); await flush(); h.me.mockResolvedValue({ id: "u2" });
    await expect(render().begin({ question: "问", answer: "", mode: "scene", status: "streaming" })).rejects.toThrow("用户或项目已切换");
    expect(h.create).not.toHaveBeenCalled(); expect(h.save).not.toHaveBeenCalled();
  });
  it("invalidates a writer conversation lease when a new session is selected", async () => {
    render(); await flush();
    const saved = await render().begin({ question: "问", answer: "", mode: "scene", status: "streaming" });
    await saved?.writer.flush();
    expect(saved?.isCurrent()).toBe(true);
    render().newSession();
    expect(saved?.isCurrent()).toBe(false);
  });
  it("does not retry another project's failed snapshots from the current project", async () => {
    h.save.mockRejectedValue(new Error("offline"));
    render(); await flush();
    const saved = await render().begin({ question: "问", answer: "", mode: "scene", status: "streaming" });
    await expect(saved?.writer.flush()).rejects.toThrow("offline");
    render("another-project"); await flush();
    const count = h.save.mock.calls.length;
    await render("another-project").retrySave();
    expect(h.save).toHaveBeenCalledTimes(count);
  });
  it("does not restore late message pages over an explicitly new conversation", async () => {
    let complete!: (page: unknown) => void;
    h.messages.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
    render(); await flush(); render().newSession();
    complete({ session, messages: [{ id: "late", question: "旧问题", answer: "旧答案", mode: "scene", status: "completed" }] });
    await flush();
    expect(render().conversation).toEqual([]); expect(render().sessionId).toBe("");
  });
});

// ── T13（审计 §二 T13：作用域切换 writers.clear() 使旧作用域未落盘片段失去重试入口）──
describe("assistant session save retry across scopes (T13)", () => {
  it("keeps a failed snapshot retryable after a scope switch and retries it into its own session", async () => {
    h.save.mockRejectedValueOnce(new Error("offline"));
    render(); await flush();
    const saved = await render().begin({ question: "问", answer: "片段", mode: "scene", status: "streaming" });
    await expect(saved?.writer.flush()).rejects.toThrow("offline");
    // 以前会坏：切作用域即 clear()，retrySave 只刷新作用域 writer，旧片段永久滞留。
    render("p", "dashboard"); await flush();
    const count = h.save.mock.calls.length;
    await render("p", "dashboard").retrySave();
    expect(h.save.mock.calls.length).toBe(count + 1);
    const [project, session, message] = h.save.mock.calls.at(-1)!;
    // 保存闭包仍指向原会话：片段写回它所属的 project/session/message，不串到新作用域。
    expect([project, session, message]).toEqual(["p", "s", saved!.message]);
    expect(render("p", "dashboard").error).toBe("");
  });
  it("surfaces a stale-scope save failure on the visible error line instead of silence", async () => {
    h.save.mockRejectedValue(new Error("offline"));
    render(); await flush();
    const saved = await render().begin({ question: "问", answer: "", mode: "scene", status: "streaming" });
    render("p", "dashboard"); await flush();
    // 以前会坏：identity 不匹配时 onError 直接 return，滞留片段失败零提示（K8 教训）。
    await expect(saved?.writer.flush()).rejects.toThrow("offline");
    expect(render("p", "dashboard").error).toContain("此前作用域的会话保存失败");
  });
  it("drops settled writers on scope switch so a later retry does not double-save", async () => {
    render(); await flush();
    const saved = await render().begin({ question: "问", answer: "", mode: "scene", status: "streaming" });
    await saved?.writer.flush();
    render("p", "dashboard"); await flush();
    const count = h.save.mock.calls.length;
    await render("p", "dashboard").retrySave();
    expect(h.save.mock.calls.length).toBe(count);
  });
  it("flushes a scope-switched in-flight streaming snapshot on retry instead of stranding it", async () => {
    h.save.mockResolvedValue({ updatedAt: "2026-09-29T00:00:00.000Z" });
    render(); await flush();
    const saved = await render().begin({ question: "问", answer: "", mode: "scene", status: "streaming" });
    render("p", "dashboard"); await flush();
    const count = h.save.mock.calls.length;
    await render("p", "dashboard").retrySave();
    expect(h.save.mock.calls.length).toBe(count + 1);
    expect(h.save.mock.calls.at(-1)?.[2]).toBe(saved!.message);
  });
});

describe("assistant session cross-tab sync (K12)", () => {
  it("surfaces a labeled conflict instead of a generic error when a save hits a cross-tab 409", async () => {
    h.save.mockRejectedValue(Object.assign(new Error("该消息已被其他窗口更新，请刷新获取最新状态"), { status: 409, body: { code: "message-version-conflict" } }));
    render(); await flush();
    const saved = await render().begin({ question: "问", answer: "", mode: "scene", status: "streaming" });
    await expect(saved?.writer.flush()).rejects.toMatchObject({ status: 409 });
    const state = render();
    expect(state.conflict).toBe(true);
    expect(state.error).toBe("");
  });
  it("keeps plain save failures on the retryable error line instead of the conflict banner", async () => {
    h.save.mockRejectedValue(new Error("offline"));
    render(); await flush();
    const saved = await render().begin({ question: "问", answer: "", mode: "scene", status: "streaming" });
    await expect(saved?.writer.flush()).rejects.toThrow("offline");
    const state = render();
    expect(state.conflict).toBe(false);
    expect(state.error).toContain("会话保存失败");
  });
  it("clears the conflict flag when the conversation is reloaded", async () => {
    h.save.mockRejectedValue(Object.assign(new Error("conflict"), { status: 409, body: {} }));
    render(); await flush();
    const saved = await render().begin({ question: "问", answer: "", mode: "scene", status: "streaming" });
    await expect(saved?.writer.flush()).rejects.toThrow();
    expect(render().conflict).toBe(true);
    await render().refresh();
    await flush();
    expect(render().conflict).toBe(false);
  });
  it("marks the conversation as externally updated for other tabs' writes and ignores its own broadcasts", async () => {
    const received: string[] = [];
    class FakeChannel {
      onmessage: ((event: { data: string }) => void) | null = null;
      constructor(public name: string) { channels.push(this); }
      postMessage(raw: string) { received.push(raw); }
      close() { /* 测试无资源 */ }
    }
    vi.stubGlobal("BroadcastChannel", FakeChannel);
    render(); await flush();
    const hook = render();
    const saved = await hook.begin({ question: "问", answer: "", mode: "scene", status: "streaming" });
    await saved?.writer.flush();
    const channel = channels.at(-1)!;
    // 自己的广播回环被忽略（真实 BroadcastChannel 不回环，这里显式验证 tab 去重）。
    expect(received.length).toBeGreaterThan(0);
    channel.onmessage?.({ data: received[0]! });
    expect(render().externalSessionId).toBeUndefined();
    // 其他标签页同项目同作用域的写入 → 标记可载入。
    const own = JSON.parse(received[0]!) as { tab: string; session: string };
    channel.onmessage?.({ data: JSON.stringify({ ...own, tab: "other-tab" }) });
    expect(render().externalSessionId).toBe(own.session);
    // 项目或作用域不匹配的广播被丢弃。
    channel.onmessage?.({ data: JSON.stringify({ tab: "other-tab", project: "elsewhere", scope: "scene", session: "s2" }) });
    expect(render().externalSessionId).toBe(own.session);
  });
});
