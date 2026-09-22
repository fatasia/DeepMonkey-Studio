import type { AiAssistantResponse } from "@bim-studio/contracts";

/** 每条请求拥有自己的 reader；终止事件、取消与解析失败都释放连接。 */
export async function readAssistantStream(response: Response, onDelta: (delta: string) => void, signal?: AbortSignal,
  onExecution?: (execution: AiAssistantResponse["execution"]) => void): Promise<AiAssistantResponse> {
  if (!response.body) throw new Error("浏览器不支持流式响应");
  const reader = response.body.getReader();
  const cancel = () => { void reader.cancel().catch(() => undefined); };
  signal?.addEventListener("abort", cancel, { once: true });
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    signal?.throwIfAborted();
    for (;;) {
      const { done, value } = await reader.read();
      signal?.throwIfAborted();
      buffer += decoder.decode(value, { stream: !done });
      const events = buffer.split(/\r?\n\r?\n/);
      buffer = events.pop() ?? "";
      for (const block of events) {
        signal?.throwIfAborted();
        const lines = block.split(/\r?\n/);
        const event = lines.find(line => line.startsWith("event:"))?.slice(6).trim();
        const data = lines.filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
        if (!data || !["delta", "execution", "error", "done"].includes(event ?? "")) continue;
        const payload: unknown = JSON.parse(data);
        if (!payload || typeof payload !== "object") throw new Error("AI 流式响应格式无效");
        if (event === "delta" && "delta" in payload && typeof payload.delta === "string") onDelta(payload.delta);
        if (event === "execution" && "execution" in payload) {
          const receipt = payload.execution as AiAssistantResponse["execution"] | null;
          if (receipt === null) onExecution?.(undefined);
          else if (receipt && ["responses", "chat-completions"].includes(receipt.protocol) && typeof receipt.requestedModel === "string") onExecution?.(receipt);
          else throw new Error("AI 执行信息格式无效");
        }
        if (event === "error") throw new Error("message" in payload && typeof payload.message === "string" ? payload.message : "AI 流式请求失败");
        if (event === "done") {
          if (!("text" in payload) || typeof payload.text !== "string") throw new Error("AI 流式响应格式无效");
          return payload as AiAssistantResponse;
        }
      }
      if (done) break;
    }
    throw new Error("AI 流式响应意外结束");
  } finally {
    signal?.removeEventListener("abort", cancel);
    cancel();
    reader.releaseLock();
  }
}
