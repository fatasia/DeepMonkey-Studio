import { PATH_TRACE_RESOLUTIONS, estimatePathTraceSeconds, formatPathTraceDuration, formatPathTraceMiB, pathTraceHeight,
  type PathTraceTierState } from "../delivery/pathTraceAuthorBudget";
import { translate as tr, type AppLocale } from "../i18n";

interface Props { readonly locale: AppLocale; readonly width: number; readonly disabled: boolean; readonly samples: number;
  readonly tiers: readonly PathTraceTierState[]; readonly budgetBytes: number; readonly workers: number;
  readonly onChange: (width: number) => void }

/** Resolution tiers with a time hint; a tier that cannot fit the memory budget is disabled with its reason as tooltip. */
export function PathTraceResolutionPicker(props: Props) {
  const { locale } = props, selected = Math.max(0, PATH_TRACE_RESOLUTIONS.indexOf(props.width as never));
  const state = props.tiers[selected]!, workers = state.workers || 1;
  const reason = (index: number) => {
    const tier = props.tiers[index]!;
    return tier.available ? "" : tr(locale, `预估内存 ${formatPathTraceMiB(tier.estimate.totalBytes)} 超出预算 ${formatPathTraceMiB(props.budgetBytes)}，已禁用`,
      `Estimated ${formatPathTraceMiB(tier.estimate.totalBytes)} exceeds the ${formatPathTraceMiB(props.budgetBytes)} memory budget`);
  };
  return <div className="path-trace-field" role="group" aria-label={tr(locale, "分辨率", "Resolution")}>
    <span className="path-trace-field-label">{tr(locale, "分辨率", "Resolution")}</span>
    <div className="path-trace-tiers" role="radiogroup">
      {PATH_TRACE_RESOLUTIONS.map((value, index) => <span key={value} title={reason(index)}>
        <button type="button" role="radio" aria-checked={value === props.width} className="path-trace-tier" disabled={props.disabled || !props.tiers[index]!.available}
          onClick={() => props.onChange(value)}>{value}{value === 1920 && <em>1080p</em>}</button></span>)}
    </div>
    <p className="path-trace-hint" data-warning={!state.available || undefined}>
      {state.available
        ? tr(locale, `${props.width} × ${pathTraceHeight(props.width)} · ${workers} 线程 · 64 spp ≈ ${formatPathTraceDuration(estimatePathTraceSeconds(props.width, 64, workers))} · 上限 ≈ ${formatPathTraceDuration(estimatePathTraceSeconds(props.width, props.samples, workers))} · 内存 ≈ ${formatPathTraceMiB(state.estimate.totalBytes)}`,
          `${props.width} × ${pathTraceHeight(props.width)} · ${workers} threads · 64 spp ≈ ${formatPathTraceDuration(estimatePathTraceSeconds(props.width, 64, workers))} · limit ≈ ${formatPathTraceDuration(estimatePathTraceSeconds(props.width, props.samples, workers))} · memory ≈ ${formatPathTraceMiB(state.estimate.totalBytes)}`)
        : reason(selected)}
    </p>
  </div>;
}
