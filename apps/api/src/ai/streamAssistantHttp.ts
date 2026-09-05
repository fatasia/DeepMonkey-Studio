import type { ServerResponse } from "node:http";
import type { AssistantService, AssistantStreamEvent } from "./assistantService.js";

/** 先做输入检查再提交 SSE 头；取消后不再发送迟到事件，并关闭迭代器。 */
export async function streamAssistantHttp(raw: ServerResponse, assistant: AssistantService, request: Parameters<AssistantService["complete"]>[0]): Promise<void> {
  const iterator = assistant.stream(request)[Symbol.asyncIterator]();
  try {
    request.signal?.throwIfAborted();
    const first = await iterator.next();
    request.signal?.throwIfAborted();
    raw.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-transform", connection: "keep-alive", "x-accel-buffering": "no" });
    raw.flushHeaders();
    if (!first.done) writeAssistantEvent(raw, first.value);
    for await (const event of { [Symbol.asyncIterator]: () => iterator }) {
      request.signal?.throwIfAborted();
      writeAssistantEvent(raw, event);
    }
    raw.end();
  } finally {
    await iterator.return?.();
  }
}

function writeAssistantEvent(raw: ServerResponse, event: AssistantStreamEvent): void {
  if (event.type === "delta") raw.write(`event: delta\ndata: ${JSON.stringify({ delta: event.delta })}\n\n`);
  else raw.write(`event: done\ndata: ${JSON.stringify(event.result)}\n\n`);
}
