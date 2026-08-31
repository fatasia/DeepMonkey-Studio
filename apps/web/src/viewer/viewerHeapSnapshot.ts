import type { HeapSnapshot } from "./framePerformanceMonitor";

/** 读取 Chromium 提供的可选堆内存指标；其他浏览器会安全返回 undefined。 */
export function readHeapSnapshot(): HeapSnapshot | undefined {
  const memory = (performance as Performance & {
    memory?: { usedJSHeapSize: number; totalJSHeapSize: number; jsHeapSizeLimit: number };
  }).memory;
  if (!memory) return undefined;
  return {
    usedBytes: memory.usedJSHeapSize,
    totalBytes: memory.totalJSHeapSize,
    limitBytes: memory.jsHeapSizeLimit
  };
}
