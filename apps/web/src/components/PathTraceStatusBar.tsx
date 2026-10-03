import { translate as tr, type AppLocale } from "../i18n";
import { formatPathTraceDuration } from "../delivery/pathTraceAuthorBudget";
import type { PathTraceParallelProgress } from "../delivery/pathTraceAuthorParallel";

interface Props { readonly locale: AppLocale; readonly status: string; readonly phase: string; readonly samples: number;
  readonly workers: number; readonly progress: PathTraceParallelProgress | undefined }

/** Merged progress of all render threads: one spp counter, one noise value, one meter. */
export function PathTraceStatusBar({ locale, status, phase, progress, samples, workers }: Props) {
  const ratio = progress ? Math.min(1, progress.samples / samples) : 0;
  const remaining = progress && progress.samplesPerSecond > 0 ? (samples - progress.samples) / progress.samplesPerSecond : Infinity;
  return <div className="path-trace-status" role="status" data-phase={phase}>
    <div className="path-trace-status-line"><strong>{status}</strong>
      <span>{progress ? `${progress.samples} spp · ${Number.isFinite(progress.noise) ? (progress.noise * 100).toFixed(2) : "—"}% · ${progress.samplesPerSecond.toFixed(2)} spp/s`
        + ` · ${workers} ${tr(locale, "线程", "threads")} · ${formatPathTraceDuration(progress.elapsedMs / 1000)}`
        + (phase === "accumulating" ? ` · ${tr(locale, "最长剩余", "max left")} ${formatPathTraceDuration(remaining)}` : "") : ""}</span></div>
    <div className="path-trace-meter" role="progressbar" aria-valuemin={0} aria-valuemax={samples} aria-valuenow={progress?.samples ?? 0}
      aria-label={tr(locale, "样本进度", "Sample progress")}><i style={{ transform: `scaleX(${ratio})` }}/></div>
  </div>;
}
