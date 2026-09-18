import type { FramePerformanceSnapshot, HeapSnapshot } from "./framePerformanceMonitor";
import type { MainThreadLongTaskSnapshot } from "./mainThreadLongTaskMonitor";

export interface PresentationPerformanceSource {
  snapshot(heap?: HeapSnapshot, mainThread?: MainThreadLongTaskSnapshot): FramePerformanceSnapshot;
  sampleWindow?(runId: string): import("@bim-studio/deep-engine").SampleWindow;
  setGpuTimingEnabled(enabled: boolean): void;
  reset(): void;
}
export function getPresentationBenchmarkSampleWindow(owner: object, runId: string): import("@bim-studio/deep-engine").SampleWindow | undefined {
  return bindings.get(owner)?.source?.sampleWindow?.(runId);
}
interface PerformanceBinding { enabled: boolean; source?: PresentationPerformanceSource }
const bindings = new WeakMap<object, PerformanceBinding>();

export function getPresentationPerformance(owner: object): PresentationPerformanceSource | undefined {
  return bindings.get(owner)?.source;
}
export function bindPresentationPerformance(owner: object, source: PresentationPerformanceSource | undefined): void {
  const previous = bindings.get(owner);
  if (previous?.source === source) return;
  previous?.source?.setGpuTimingEnabled(false);
  const enabled = previous?.enabled ?? false;
  bindings.set(owner, { enabled, ...(source ? { source } : {}) });
  source?.setGpuTimingEnabled(enabled);
}
export function enablePresentationGpuTiming(owner: object, enabled: boolean): void {
  const current = bindings.get(owner) ?? { enabled: false };
  current.enabled = enabled; bindings.set(owner, current);
  current.source?.setGpuTimingEnabled(enabled);
}
