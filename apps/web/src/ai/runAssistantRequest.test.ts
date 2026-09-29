import { describe, expect, it, vi } from "vitest";
import type { BimAssistantPreparedContext } from "../bimAssistant";
import { dashboardAssistantStreamText, runAssistantRequest } from "./runAssistantRequest";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function setup() {
  const controller = new AbortController();
  const client = { invokeCapability: vi.fn(), streamAssistant: vi.fn(), listDatasets: vi.fn() };
  const input: Parameters<typeof runAssistantRequest>[0] = {
    client, mode: "bim", prompt: "检查设备", projectId: "project-1", locale: "zh-CN",
    context: {}, platformContext: {}, sources: [], recentConversation: [], signal: controller.signal, onDelta: vi.fn(),
  };
  return { controller, client, input };
}

describe("assistant request lifecycle", () => {
  it("passes session overrides to the stream without changing shared settings", async () => {
    const { client, input } = setup();
    input.sessionOptions = { model: "selected", reasoningEffort: "deep" };
    client.streamAssistant.mockResolvedValue({ text: "ok", model: "selected" });
    await runAssistantRequest(input);
    expect(client.streamAssistant.mock.calls[0]?.[4]).toMatchObject(input.sessionOptions);
  });
  it("uses the shared stream while exposing only dashboard summary text and returning the page draft", async () => {
    const { client, input } = setup();
    input.mode = "dashboard";
    const draft = { version: 1, pageId: "page-1", changes: [] };
    client.streamAssistant.mockImplementation(async (_mode, _prompt, _context, onDelta) => {
      onDelta('{"text":"正在生成');
      onDelta('\\n二维草案","dashboardPageDraft":');
      return { text: "正在生成\n二维草案", model: "selected", dashboardPageDraft: draft };
    });
    const result = await runAssistantRequest(input);
    expect(input.onDelta).toHaveBeenCalledWith("正在生成");
    expect(input.onDelta).toHaveBeenCalledWith("\n二维草案");
    expect(input.onDelta).not.toHaveBeenCalledWith(expect.stringContaining("dashboardPageDraft"));
    expect(result.dashboardPageDraft).toEqual(draft);
    expect(dashboardAssistantStreamText('{"text":"产量\\n趋势","dashboardPageDraft":')).toBe("产量\n趋势");
  });
  it("does not prepare or request anything when already cancelled", async () => {
    const { controller, client, input } = setup();
    input.prepareBim = vi.fn();
    controller.abort();
    await expect(runAssistantRequest(input)).rejects.toMatchObject({ name: "AbortError" });
    expect(input.prepareBim).not.toHaveBeenCalled();
    expect(client.streamAssistant).not.toHaveBeenCalled();
  });

  it("closing while BIM preparation is pending cannot launch a late stream", async () => {
    const { controller, client, input } = setup();
    const prepared = deferred<BimAssistantPreparedContext>();
    input.prepareBim = () => prepared.promise;
    input.onPrepared = vi.fn();
    const request = runAssistantRequest(input);
    controller.abort();
    prepared.resolve({} as BimAssistantPreparedContext);
    await expect(request).rejects.toMatchObject({ name: "AbortError" });
    expect(client.streamAssistant).not.toHaveBeenCalled();
    expect(input.onPrepared).not.toHaveBeenCalled();
  });

  it("keeps already prepared BIM evidence visible even if the model later fails", async () => {
    const { client, input } = setup();
    const prepared = { confidence: "exact", matchCount: 2 } as BimAssistantPreparedContext;
    input.prepareBim = async () => prepared;
    input.onPrepared = vi.fn();
    client.streamAssistant.mockRejectedValue(new Error("provider unavailable"));
    await expect(runAssistantRequest(input)).rejects.toThrow("provider unavailable");
    expect(input.onPrepared).toHaveBeenCalledExactlyOnceWith(prepared);
    expect(client.streamAssistant.mock.calls[0]?.[2]).toMatchObject({ bimEvidence: prepared });
  });

  it("cancels both SQL stages and never reads after a cancelled draft returns", async () => {
    const { controller, client, input } = setup();
    const draft = deferred<unknown>();
    input.mode = "sql";
    client.invokeCapability.mockReturnValue(draft.promise);
    const request = runAssistantRequest(input);
    expect(client.invokeCapability).toHaveBeenCalledWith("project-1", "data.query.draft", { prompt: input.prompt }, "web-user", controller.signal);
    controller.abort();
    draft.resolve({ output: { planning: { plan: { datasetId: "telemetry" } } } });
    await expect(request).rejects.toMatchObject({ name: "AbortError" });
    expect(client.invokeCapability).toHaveBeenCalledTimes(1);
  });

  it("discards a late SQL result even when the transport ignores abort", async () => {
    const { controller, client, input } = setup();
    const read = deferred<unknown>();
    input.mode = "sql";
    client.invokeCapability.mockResolvedValueOnce({ output: { planning: { plan: { datasetId: "telemetry" } } } }).mockReturnValueOnce(read.promise);
    const request = runAssistantRequest(input);
    await vi.waitFor(() => expect(client.invokeCapability).toHaveBeenCalledTimes(2));
    expect(client.invokeCapability.mock.calls[1]?.[4]).toBe(controller.signal);
    controller.abort();
    read.resolve({ output: { rows: [] } });
    await expect(request).rejects.toMatchObject({ name: "AbortError" });
  });

  it("discards late stream events/results after cancellation", async () => {
    const { controller, client, input } = setup();
    const response = deferred<unknown>();
    client.streamAssistant.mockReturnValue(response.promise);
    const request = runAssistantRequest(input);
    const delta = client.streamAssistant.mock.calls[0]?.[3];
    delta("有效片段");
    controller.abort();
    delta("过期片段");
    response.resolve({ text: "过期结果" });
    await expect(request).rejects.toMatchObject({ name: "AbortError" });
    expect(input.onDelta).toHaveBeenCalledExactlyOnceWith("有效片段");
  });

  it("keeps controlled SQL results and evidence in the successful path", async () => {
    const { client, input } = setup();
    input.mode = "sql";
    client.invokeCapability.mockResolvedValueOnce({ output: { planning: { plan: { datasetId: "telemetry" } }, model: "planner" }, warnings: [] })
      .mockResolvedValueOnce({ output: { datasetName: "设备运行趋势", columns: [{ key: "value", label: "温度" }], rows: [{ value: 24.12345 }], matchedRows: 1, returnedRows: 1, evidenceFingerprint: "fp-1" }, warnings: [], evidence: [{}], traceId: "read-1" });
    const result = await runAssistantRequest(input);
    expect(result.text).toContain("温度: 24.123");
    expect(result.text).toContain("Evidence: fp-1");
    expect(result.reliability).toMatchObject({ grade: "capability-verified", traceId: "read-1" });
    expect(result.model).toBe("planner");
  });

  it("stops an invalid draft without attempting a data read", async () => {
    const { client, input } = setup();
    input.mode = "sql";
    client.invokeCapability.mockResolvedValue({ output: { planning: { issues: [{ message: "需要选择数据集" }] } }, warnings: [] });
    await expect(runAssistantRequest(input)).rejects.toThrow("需要选择数据集");
    expect(client.invokeCapability).toHaveBeenCalledTimes(1);
  });

  // ── T2 回归（审计 P1-9 chat 最小版：needs-input 歧义只能散文报错，无结构化澄清）──
  it("T2: turns a needs-input draft into a structured clarification fed by the server dataset catalog", async () => {
    const { client, input } = setup();
    input.mode = "sql";
    client.invokeCapability.mockResolvedValue({
      output: { planning: { status: "needs-input", issues: [{ path: "datasetId", code: "dataset-not-found", message: "数据集「产量」不唯一" }] }, model: "planner" },
      warnings: [], traceId: "draft-1",
    });
    client.listDatasets.mockResolvedValue([
      { id: "d1", projectId: "project-1", name: "产线小时产量" },
      { id: "d2", projectId: "project-1", name: "质量检测记录" },
      { id: "d3", projectId: "other-project", name: "别人项目的数据" },
    ]);
    const result = await runAssistantRequest(input);
    // 以前会坏：直接 throw，用户只能看到一句错误；现在返回可就地作答的澄清卡数据源。
    expect(result.clarification).toEqual({
      question: "数据集「产量」不唯一",
      options: [{ id: "d1", label: "产线小时产量" }, { id: "d2", label: "质量检测记录" }],
    });
    expect(result.text).toContain("不唯一");
    // 澄清轮无证据读取，可靠性如实保持 limited，不冒充 capability-verified。
    expect(result.reliability).toMatchObject({ grade: "limited", contextTrust: "capability-result" });
  });

  it("T2: keeps the hard error when needs-input has no candidate datasets (never fabricates options)", async () => {
    const { client, input } = setup();
    input.mode = "sql";
    client.invokeCapability.mockResolvedValue({
      output: { planning: { status: "needs-input", issues: [{ message: "无法确定数据集" }] } }, warnings: [],
    });
    client.listDatasets.mockResolvedValue([]);
    await expect(runAssistantRequest(input)).rejects.toThrow("无法确定数据集");
    expect(client.listDatasets).toHaveBeenCalled();
  });
});
