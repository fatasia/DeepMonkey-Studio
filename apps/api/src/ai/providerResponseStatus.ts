/** 兼容协议的 HTTP 200 不等于生成成功；先检查生成状态，再接收正文。 */
export function inspectProviderResponse(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("大模型响应格式无效");
  const event = value as Record<string, unknown>;
  const response = event.response && typeof event.response === "object" ? event.response as Record<string, unknown> : event;
  const error = response.error ?? event.error;
  if (error || event.type === "error" || event.type === "response.failed" || response.status === "failed") {
    const detail = error && typeof error === "object" ? error as Record<string, unknown> : event;
    const message = [detail.code, detail.message].filter(item => typeof item === "string").join(": ").slice(0, 500);
    throw new Error(`大模型生成失败${message ? `：${message}` : ""}`);
  }
  if (event.type === "response.incomplete" || response.status === "incomplete") throw new Error("大模型回答未完成，已保留收到的内容，请重试");
  if (response.status === "cancelled") throw new Error("大模型生成已取消");
  const choices = Array.isArray(event.choices) ? event.choices : [];
  const first = choices[0] as { finish_reason?: unknown } | undefined;
  if (first?.finish_reason === "length") throw new Error("大模型回答达到输出上限，已保留收到的内容，请缩小问题范围后重试");
  if (first?.finish_reason === "content_filter") throw new Error("大模型未能完成本次回答");
  return event.type === "response.completed" || response.status === "completed" || first?.finish_reason === "stop";
}
