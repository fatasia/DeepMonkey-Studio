/** 等待执行器、取消或截止时间；迟到的执行器结果不再参与任务发布。 */
export async function withConversionDeadline(
  execute: () => Promise<void>,
  controller: AbortController,
  timeoutMs: number,
  waitForResources: () => Promise<void> = async () => {},
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const interruption = new Promise<never>((_, reject) => {
    onAbort = () => reject(controller.signal.reason ?? new Error("转换已取消"));
    controller.signal.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(() => controller.abort(new Error(`转换器运行超时（${timeoutMs} 毫秒）`)), timeoutMs);
  });
  try {
    await Promise.race([Promise.resolve().then(() => {
      controller.signal.throwIfAborted();
      return execute();
    }), interruption]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (onAbort) controller.signal.removeEventListener("abort", onAbort);
    // 中断 Promise 不等于执行资源已停止；终态和下一任务必须等待子进程退出。
    await waitForResources();
  }
}
