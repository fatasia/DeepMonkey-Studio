export type DashboardExportState = { busy: boolean; error: string; completed: boolean };

/** 一次仅允许一项导出；取消、切页和超时后的迟到结果不能覆盖新任务状态。 */
export function createDashboardExportSession(notify: (state: DashboardExportState) => void) {
  let current: AbortController | undefined;
  let pendingTimeout: ReturnType<typeof setTimeout> | undefined;
  return {
    cancel(silent = false) {
      current?.abort();
      clearTimeout(pendingTimeout);
      current = undefined;
      if (!silent) notify({ busy: false, error: "", completed: false });
    },
    async run(work: (signal: AbortSignal) => Promise<void>, timeoutMessage: string) {
      if (current) return;
      const controller = new AbortController();
      current = controller;
      notify({ busy: true, error: "", completed: false });
      const timeout = setTimeout(() => {
        if (current !== controller) return;
        controller.abort();
        current = undefined;
        notify({ busy: false, error: timeoutMessage, completed: false });
      }, 60_000);
      pendingTimeout = timeout;
      try {
        await work(controller.signal);
        if (current === controller) notify({ busy: false, error: "", completed: true });
      } catch (reason) {
        if (current === controller) notify({ busy: false, error: reason instanceof Error ? reason.message : String(reason), completed: false });
      } finally {
        clearTimeout(timeout);
        if (current === controller) current = undefined;
      }
    },
  };
}
