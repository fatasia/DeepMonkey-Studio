import type { RendererCapabilityProbe, RendererReadiness } from "../rendererCapabilities";
import type { FramePerformanceSnapshot } from "./framePerformanceMonitor";
import type { RendererBackend } from "./viewerTypes";

interface RendererDiagnosticInput {
  current: RendererBackend;
  probe: RendererCapabilityProbe | undefined;
  readiness: RendererReadiness[];
  performance: FramePerformanceSnapshot | undefined;
}

/** 形成不含项目业务数据的可移交诊断证据，便于客户现场和研发使用同一口径定位。 */
export function createRendererDiagnosticEvidence(input: RendererDiagnosticInput, createdAt = new Date().toISOString(), userAgent = navigator.userAgent) {
  return {
    schemaVersion: 1,
    createdAt,
    userAgent,
    currentBackend: input.current,
    capabilityProbe: input.probe,
    readiness: input.readiness,
    performance: input.performance
  };
}

export function downloadRendererDiagnosticEvidence(input: RendererDiagnosticInput): void {
  const evidence = createRendererDiagnosticEvidence(input);
  const blob = new Blob([`${JSON.stringify(evidence, null, 2)}\n`], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `renderer-diagnostics-${evidence.createdAt.replace(/[:.]/g, "-")}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
}
