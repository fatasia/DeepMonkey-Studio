const RETRYABLE_STATUS = new Set([502, 503, 504]);
const DEFAULT_DELAY_MS = 500;
const MAX_DELAY_MS = 2_000;

/** 仅重试尚未取得成功响应的读取；成功后的解析/流中断由调用者处理，不重放。 */
export async function recoverReadOnce(
  attempt: () => Promise<Response>,
  assertIdentity: () => Promise<void>,
  signal?: AbortSignal | null,
): Promise<Response> {
  let response: Response | undefined;
  try { response = await attempt(); }
  catch (error) {
    signal?.throwIfAborted();
    // Fetch 的网络故障使用 TypeError；Abort/Timeout 和适配器业务异常不属于重连。
    if (!(error instanceof TypeError)) throw error;
  }
  if (response && !RETRYABLE_STATUS.has(response.status)) return response;
  const delay = response ? retryDelay(response.headers.get("retry-after")) : DEFAULT_DELAY_MS;
  if (delay === undefined) return response!;
  // 放弃的失败响应及时释放，不等大错误页读取完成才重连。
  if (response?.body) void response.body.cancel().catch(() => {});
  await waitForRetry(delay, signal);
  await assertIdentity();
  signal?.throwIfAborted();
  return attempt();
}

function retryDelay(retryAfter: string | null): number | undefined {
  if (!retryAfter) return DEFAULT_DELAY_MS;
  const seconds = /^\d+$/.test(retryAfter.trim()) ? Number(retryAfter) : undefined;
  const requested = seconds === undefined ? Date.parse(retryAfter) - Date.now() : seconds * 1_000;
  if (!Number.isFinite(requested)) return DEFAULT_DELAY_MS;
  // 长冷却不提前重试或让界面长时间悬置，保留原始HTTP错误供显式恢复。
  return requested > MAX_DELAY_MS ? undefined : Math.max(DEFAULT_DELAY_MS, requested);
}

function waitForRetry(delay: number, signal?: AbortSignal | null): Promise<void> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); };
    const abort = () => { cleanup(); reject(signal?.reason); };
    const timer = setTimeout(() => { cleanup(); resolve(); }, delay);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}
