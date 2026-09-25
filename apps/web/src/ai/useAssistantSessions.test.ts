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
function render(project = "p", scope = "scene") { h.cursor = 0; const result = useAssistantSessions(project, scope); h.effects.splice(0).forEach(effect => effect()); return result; }
async function flush() { for (let index = 0; index < 30; index++) await Promise.resolve(); }
beforeEach(() => {
  h.cells = []; h.effects = []; h.cleanups = []; vi.resetAllMocks(); vi.stubGlobal("window", new EventTarget());
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
