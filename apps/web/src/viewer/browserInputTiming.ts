interface FirstInputTiming { startTimeMs: number; inputDelayMs: number; processingTimeMs: number; eventDurationMs: number; }
let firstInput: FirstInputTiming | undefined;
let supported = typeof PerformanceObserver !== "undefined" && (PerformanceObserver.supportedEntryTypes ?? []).includes("first-input");
if (supported) {
  try {
  const observer = new PerformanceObserver(list => {
    const entry = list.getEntries()[0] as PerformanceEventTiming | undefined;
    if (!entry) return;
    firstInput = { startTimeMs: entry.startTime, inputDelayMs: Math.max(0, entry.processingStart - entry.startTime),
      processingTimeMs: Math.max(0, entry.processingEnd - entry.processingStart), eventDurationMs: entry.duration };
    observer.disconnect();
  });
  observer.observe({ type: "first-input", buffered: true });
  } catch { supported = false; }
}

/** 文档级浏览器首输入证据；不冒充查看器首次可交互时刻或 INP。 */
export function readBrowserInputTiming() { return { scope: "document-first-input" as const, supported, ...(firstInput ? { firstInput: { ...firstInput } } : {}) }; }
