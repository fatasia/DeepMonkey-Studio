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
    // K9 合同演进:下游收级联 signal(外部取消/整体超时都会 abort),身份不再是外层对象。
    const downstreamSignal = client.invokeCapability.mock.calls[0]?.[4] as AbortSignal;
    expect(downstreamSignal).not.toBe(controller.signal);
    controller.abort();
    expect(downstreamSignal.aborted).toBe(true);
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
    const downstreamSignal = client.invokeCapability.mock.calls[1]?.[4] as AbortSignal;
    expect(downstreamSignal).not.toBe(controller.signal);
    controller.abort();
    expect(downstreamSignal.aborted).toBe(true);
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

  // ── H-C5-T1：服务端透传候选优先消费，web 不再重复拉目录自拼 ──
  it("T1: prefers server-transmitted planning candidates without re-fetching the dataset catalog", async () => {
    const { client, input } = setup();
    input.mode = "sql";
    client.invokeCapability.mockResolvedValue({
      output: {
        planning: {
          status: "needs-input",
          issues: [{ path: "datasetId", code: "dataset-not-found", message: "数据集「产量」不唯一" }],
          candidates: [
            { id: "s1", name: "服务端候选产线产量", updatedAt: "2026-10-01T00:00:00.000Z" },
            { id: "s2", name: "服务端候选质检记录", updatedAt: "2026-10-01T00:00:00.000Z" },
          ],
        },
        model: "planner",
      },
      warnings: [], traceId: "draft-t1",
    });
    const result = await runAssistantRequest(input);
    expect(result.clarification).toEqual({
      question: "数据集「产量」不唯一",
      options: [{ id: "s1", label: "服务端候选产线产量" }, { id: "s2", label: "服务端候选质检记录" }],
    });
    expect(client.listDatasets).not.toHaveBeenCalled();
    expect(result.reliability).toMatchObject({ grade: "limited", contextTrust: "capability-result" });
  });

  it("T1: falls back to the local catalog when the server transmits no candidates (old-server compat)", async () => {
    const { client, input } = setup();
    input.mode = "sql";
    client.invokeCapability.mockResolvedValue({
      output: { planning: { status: "needs-input", issues: [{ path: "datasetId", code: "dataset-not-found", message: "数据集不存在" }] }, model: "planner" },
      warnings: [], traceId: "draft-t1-fallback",
    });
    client.listDatasets.mockResolvedValue([{ id: "d1", projectId: "project-1", name: "本地目录数据集" }]);
    const result = await runAssistantRequest(input);
    expect(result.clarification?.options).toEqual([{ id: "d1", label: "本地目录数据集" }]);
    expect(client.listDatasets).toHaveBeenCalled();
  });
});

describe("K9 chat 整体 deadline", () => {
  it("流挂死时整体 deadline 触发:本地化超时错误且下游被 abort", async () => {
    const { controller, client, input } = setup();
    let downstreamAborted = false;
    client.streamAssistant.mockImplementation(async (_mode, _prompt, _context, _onDelta, options) => {
      options.signal.addEventListener("abort", () => { downstreamAborted = true; });
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
      });
    });
    await expect(runAssistantRequest({ ...input, overallDeadlineMs: 30 })).rejects.toThrow(/AI 请求超时/);
    expect(downstreamAborted).toBe(true);
    void controller;
  });

  it("手动取消仍优先:外部 abort 后错误保持 AbortError,不被 deadline 分支改写", async () => {
    const { controller, client, input } = setup();
    // 模拟真实 fetch:abort 时以 signal reason 拒绝流 promise(在监听器里 throw 会变成 uncaught)。
    client.streamAssistant.mockImplementation(async (_mode, _prompt, _context, _onDelta, options) => {
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
      });
    });
    const request = runAssistantRequest({ ...input, overallDeadlineMs: 60_000 });
    await new Promise(resolve => setTimeout(resolve, 10));
    controller.abort();
    await expect(request).rejects.toMatchObject({ name: "AbortError" });
  });

  it("正常完成不受 deadline 影响:resolve 先到即返回结果", async () => {
    const { client, input } = setup();
    client.streamAssistant.mockResolvedValue({ text: "ok", model: "selected" });
    await expect(runAssistantRequest({ ...input, overallDeadlineMs: 30 })).resolves.toMatchObject({ text: "ok" });
  });
});

describe("T7 dashboard 流式布局预览透传", () => {
  it("dashboard 模式下流式 JSON 的已闭合 widget 经 onDashboardStream 上报;非 dashboard 不回调", async () => {
    const { controller, client, input } = setup();
    input.mode = "dashboard";
    const previews: Array<{ labels: string[]; types: string[] }> = [];
    client.streamAssistant.mockImplementation(async (_mode, _prompt, _context, onDelta, options) => {
      void options;
      onDelta(`{"widgets":[{"type":"kpi","title":"OEE"},`);
      onDelta(`{"type":"chart.line","title":"温度"}]}`);
      return { text: "已生成" };
    });
    await runAssistantRequest({ ...input, onDashboardStream: preview => previews.push(preview) });
    expect(previews.at(-1)).toEqual({ labels: ["OEE", "温度"], types: ["kpi", "chart.line"] });
    void controller;
  });
});
