import { describe, expect, it, vi } from "vitest";
import { readAssistantStream } from "./assistantStream";
import { createAiApi } from "./aiApi";

it("delivers execution receipts and failover resets before completion", async () => {
  const stream = transport();
  const receipts = vi.fn();
  const pending = readAssistantStream(stream.response, vi.fn(), undefined, receipts);
  const execution = { protocol: "responses", requestedModel: "alias", reportedModel: "snapshot" };
  stream.send(`event: execution\ndata: ${JSON.stringify({ execution })}\n\nevent: execution\ndata: {"execution":null}\n\nevent: done\ndata: {"text":"ok"}\n\n`);
  await pending;
  expect(receipts.mock.calls).toEqual([[execution], [undefined]]);
});

function transport() {
  let source!: ReadableStreamDefaultController<Uint8Array>;
  const cancelled = vi.fn();
  const body = new ReadableStream<Uint8Array>({ start(controller) { source = controller; }, cancel: cancelled });
  const response = new Response(body);
  const send = (data: string) => source.enqueue(new TextEncoder().encode(data));
  return { body, response, send, source, cancelled };
}

describe("assistant response stream ownership", () => {
  it("isolates a retry from its cancelled predecessor through the real API client", async () => {
    const first = transport(); const second = transport(); const abort = new AbortController();
    const open = vi.fn().mockResolvedValueOnce(first.response).mockResolvedValueOnce(second.response);
    const client = createAiApi(async () => { throw new Error("unexpected JSON request"); }, open);
    const oldDelta = vi.fn(); const nextDelta = vi.fn();
    const old = client.streamAssistant("scene", "old", {}, oldDelta, { signal: abort.signal });
    await Promise.resolve(); abort.abort();
    const next = client.streamAssistant("scene", "retry", {}, nextDelta);
    second.send('event: delta\ndata: {"delta":"new"}\n\nevent: done\ndata: {"text":"new"}\n\n');
    await expect(old).rejects.toMatchObject({ name: "AbortError" });
    await expect(next).resolves.toEqual({ text: "new" });
    expect(oldDelta).not.toHaveBeenCalled(); expect(nextDelta).toHaveBeenCalledExactlyOnceWith("new");
    expect(first.body.locked || second.body.locked).toBe(false);
  });
  it("decodes split Chinese bytes and cancels an open connection immediately after done", async () => {
    const stream = transport(); const delta = vi.fn();
    const pending = readAssistantStream(stream.response, delta);
    const bytes = new TextEncoder().encode('event: delta\r\ndata: {"delta":"设备"}\r\n\r\nevent: done\ndata: {"text":"设备正常","model":"fixture"}\n\n');
    for (const byte of bytes) stream.source.enqueue(new Uint8Array([byte]));
    await expect(pending).resolves.toEqual({ text: "设备正常", model: "fixture" });
    expect(delta).toHaveBeenCalledExactlyOnceWith("设备");
    expect(stream.cancelled).toHaveBeenCalledTimes(1);
    expect(stream.body.locked).toBe(false);
  });

  it("aborts a pending read even if the transport did not implement AbortSignal", async () => {
    const stream = transport(); const abort = new AbortController(); const delta = vi.fn();
    const pending = readAssistantStream(stream.response, delta, abort.signal);
    abort.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(stream.cancelled).toHaveBeenCalledTimes(1);
    expect(stream.body.locked).toBe(false);
    expect(delta).not.toHaveBeenCalled();
  });

  it("does not accept queued done or deltas when cancellation happens inside a delta callback", async () => {
    const stream = transport(); const abort = new AbortController();
    const delta = vi.fn(() => abort.abort());
    const pending = readAssistantStream(stream.response, delta, abort.signal);
    stream.send('event: delta\ndata: {"delta":"first"}\n\nevent: delta\ndata: {"delta":"stale"}\n\nevent: done\ndata: {"text":"stale"}\n\n');
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(delta).toHaveBeenCalledTimes(1);
    expect(stream.body.locked).toBe(false);
  });

  it.each(['event: error\ndata: {"message":"failed"}\n\n', 'event: done\ndata: null\n\n', 'event: done\ndata: {}\n\n', 'event: delta\ndata: broken\n\n'])("releases malformed or failed stream %s", async data => {
    const stream = transport(); const pending = readAssistantStream(stream.response, vi.fn()); stream.send(data);
    await expect(pending).rejects.toThrow();
    expect(stream.cancelled).toHaveBeenCalledTimes(1);
    expect(stream.body.locked).toBe(false);
  });

  it("rejects EOF without terminal result and releases the closed reader", async () => {
    const stream = transport(); const pending = readAssistantStream(stream.response, vi.fn()); stream.source.close();
    await expect(pending).rejects.toThrow("意外结束"); expect(stream.body.locked).toBe(false);
  });
});

it("K9:idle 超时——服务器收下连接不发字节,快速失败并释放 reader", async () => {
  const stream = transport();
  const pending = readAssistantStream(stream.response, vi.fn(), undefined, undefined, 20);
  await expect(pending).rejects.toThrow(/AI 响应超时（0 秒无数据）/);
  expect(stream.cancelled).toHaveBeenCalled();
});

it("K9:流停摆——首块后无字节同样触发空闲超时", async () => {
  const stream = transport();
  const delta = vi.fn();
  const pending = readAssistantStream(stream.response, delta, undefined, undefined, 20);
  stream.send('event: delta\ndata: {"delta":"部分"}\n\n');
  await new Promise(resolve => setTimeout(resolve, 5));
  expect(delta).toHaveBeenCalledWith("部分");
  await expect(pending).rejects.toThrow(/AI 响应超时/);
  expect(stream.cancelled).toHaveBeenCalled();
});

it("K9:有字节持续到达则空闲计时逐块重置,不误伤慢流", async () => {
  const stream = transport();
  const delta = vi.fn();
  const pending = readAssistantStream(stream.response, delta, undefined, undefined, 40);
  for (let index = 0; index < 3; index++) {
    stream.send(`event: delta\ndata: {"delta":"${index}"}\n\n`);
    await new Promise(resolve => setTimeout(resolve, 15));
  }
  stream.send('event: done\ndata: {"text":"012"}\n\n');
  await expect(pending).resolves.toMatchObject({ text: "012" });
  expect(delta).toHaveBeenCalledTimes(3);
});
