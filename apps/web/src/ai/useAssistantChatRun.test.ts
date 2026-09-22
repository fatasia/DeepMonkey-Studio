import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({ cursor: 0, cells: [] as unknown[], run: vi.fn() }));
vi.mock("../api", () => ({ api: {} }));
vi.mock("./runAssistantRequest", () => ({ runAssistantRequest: h.run }));
vi.mock("react", () => ({
  useRef: (initial: unknown) => { const slot = h.cursor++; return h.cells[slot] ??= { current: initial }; },
  useState: (initial: unknown) => { const slot = h.cursor++; if (!(slot in h.cells)) h.cells[slot] = initial;
    return [h.cells[slot], (value: unknown) => { h.cells[slot] = value; }]; },
  useEffect: () => undefined,
}));
import { useAssistantChatRun } from "./useAssistantChatRun";
type Input = Parameters<typeof useAssistantChatRun>[0];
function setup() {
  const update = vi.fn(), flush = vi.fn().mockResolvedValue(undefined), isCurrent = vi.fn(() => true);
  const sessions = { loading: false, conversation: [], setConversation: vi.fn(),
    begin: vi.fn().mockResolvedValue({ message: "m", writer: { update, flush }, isCurrent }) } as unknown as Input["sessions"];
  const input: Input = { sessions, projectId: "p", requestScope: "p:scene", scopeId: "scene", scopeLabel: "场景",
    question: "问题", setQuestion: vi.fn(), mode: "scene", locale: "zh-CN", context: {}, platformContext: {}, sources: [],
    sessionOptions: {}, onBegin: vi.fn(), prepareBim: undefined };
  const render = () => { h.cursor = 0; return useAssistantChatRun(input); };
  return { input, render, update, isCurrent };
}
async function ticks() { for (let i = 0; i < 15; i++) await Promise.resolve(); }
beforeEach(() => { h.cells = []; vi.resetAllMocks(); });
afterEach(() => vi.restoreAllMocks());
describe("assistant partial conversation lifecycle", () => {
  it("retains stopped text in the next prompt history and rejects late deltas", async () => {
    const { render, update, input } = setup();
    let callbacks!: Parameters<typeof h.run>[0];
    let resolve!: (result: unknown) => void;
    h.run.mockImplementationOnce(options => { callbacks = options; return new Promise(done => { resolve = done; }); });
    const asking = render().ask(); await ticks();
    const execution = { protocol: "responses", requestedModel: "alias", reportedModel: "snapshot", servedBy: "fallback", failoverCategory: "rate-limit" };
    callbacks.onExecution(execution);
    callbacks.onDelta("部分回答"); await render().cancelRequest();
    callbacks.onExecution({ ...execution, reportedModel: "late" });
    callbacks.onDelta("迟到回答"); resolve({ text: "错误的最终回答" }); await asking;
    expect(update).toHaveBeenLastCalledWith(expect.objectContaining({ answer: "部分回答", status: "stopped", execution }));
    h.run.mockResolvedValueOnce({ text: "下一轮", reliability: undefined });
    await render().ask("继续");
    expect(h.run.mock.calls[1]?.[0].recentConversation).toEqual([
      { mode: "scene", question: "问题", answer: "部分回答", scope: "场景" },
    ]);
    expect(input.sessions.setConversation).toHaveBeenCalledWith([expect.objectContaining({ status: "stopped" })]);
  });
  it("does not append a stopped turn after its session was replaced", async () => {
    const { render, isCurrent } = setup();
    let resolve!: (result: unknown) => void;
    h.run.mockImplementationOnce(options => { options.onDelta("旧会话文字"); return new Promise(done => { resolve = done; }); });
    const asking = render().ask(); await ticks(); await render().cancelRequest();
    isCurrent.mockReturnValue(false); resolve({ text: "迟到" }); await asking;
    h.run.mockResolvedValueOnce({ text: "新会话" }); await render().ask("新问题");
    expect(h.run.mock.calls[1]?.[0].recentConversation).toEqual([]);
  });
  it("persists the same reliability snapshot that the live answer renders", async () => {
    const { render, update } = setup();
    h.run.mockResolvedValueOnce({ text: "有证据的回答", model: "primary", reliability: {
      grade: "capability-verified", contextTrust: "server-evidence", evidenceCount: 1, inputRisk: "low",
      writePolicy: "read-only", warnings: [], sourceLabels: ["场景"], traceId: "trace-1",
    } });
    await render().ask();
    expect(update).toHaveBeenLastCalledWith(expect.objectContaining({ reliability: expect.objectContaining({ grade: "capability-verified", traceId: "trace-1" }) }));
  });
});
