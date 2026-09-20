import { useEffect, useMemo, useState } from "react";
import { probeRendererCapabilities, rendererReadiness, type RendererCapabilityProbe } from "../rendererCapabilities";
import type { FramePerformanceSnapshot } from "./framePerformanceMonitor";
import type { ViewerEngine } from "./ViewerEngine";
import { readStudioFrameCaptureSnapshot, readStudioFrameReadbacks, setStudioFrameCaptureRequested,
  type StudioFrameCaptureSnapshot, type StudioFrameReadbackEntry } from "./studioFrameCaptureDiagnostics";

interface RendererDiagnosticsState {
  checking: boolean;
  probe: RendererCapabilityProbe | undefined;
  readiness: ReturnType<typeof rendererReadiness>;
  performance: FramePerformanceSnapshot | undefined;
  frameCapture: StudioFrameCaptureSnapshot;
  frameReadbacks: readonly StudioFrameReadbackEntry[];
  refresh: () => void;
}

/** 把设备探测和场景性能采样留在诊断面板生命周期内，关闭面板后不产生 React 更新。 */
export function useRendererDiagnostics(
  engine: ViewerEngine | undefined,
  open: boolean,
  postProcessingEnabled: boolean,
  onError: (reason: unknown) => void,
): RendererDiagnosticsState {
  const [probe, setProbe] = useState<RendererCapabilityProbe>();
  const [revision, setRevision] = useState(0);
  const [checking, setChecking] = useState(false);
  const [performance, setPerformance] = useState<FramePerformanceSnapshot>();
  const [frameCapture, setFrameCapture] = useState<StudioFrameCaptureSnapshot>(() => readStudioFrameCaptureSnapshot());
  const [frameReadbacks, setFrameReadbacks] = useState<readonly StudioFrameReadbackEntry[]>(() => readStudioFrameReadbacks());

  useEffect(() => {
    setStudioFrameCaptureRequested(open);
    if (!open) setFrameCapture(readStudioFrameCaptureSnapshot());
    return () => setStudioFrameCaptureRequested(false);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setChecking(true);
    void probeRendererCapabilities()
      .then((result) => {
        if (!cancelled) setProbe(result);
      })
      .catch((reason: unknown) => {
        if (!cancelled) onError(reason);
      })
      .finally(() => {
        if (!cancelled) setChecking(false);
      });
    return () => {
      cancelled = true;
    };
  }, [onError, open, revision]);

  useEffect(() => {
    if (!engine || !open) {
      engine?.setGpuTimingEnabled(false);
      setPerformance(undefined);
      return;
    }
    engine.setGpuTimingEnabled(true);
    const update = () => setPerformance(engine.getPerformanceSnapshot());
    const updateDiagnostics = () => {
      update();
      setFrameCapture(readStudioFrameCaptureSnapshot());
      setFrameReadbacks(readStudioFrameReadbacks());
    };
    updateDiagnostics();
    const timer = window.setInterval(updateDiagnostics, 500);
    return () => {
      window.clearInterval(timer);
      engine.setGpuTimingEnabled(false);
    };
  }, [engine, open]);

  const readiness = useMemo(() => (probe ? rendererReadiness(probe, { postProcessingEnabled }) : []), [postProcessingEnabled, probe]);

  return {
    checking,
    probe,
    readiness,
    performance,
    frameCapture,
    frameReadbacks,
    refresh: () => setRevision((value) => value + 1),
  };
}
