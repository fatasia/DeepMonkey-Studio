/** Bootstrap timeline marks for the editor entry; measures feed final-gate performance evidence. */
export type StartupMarkName =
  | "bootstrap-start"
  | "delivery-manifest-loaded"
  | "editor-styles-loaded"
  | "studio-render-start"
  | "scene-viewer-render-start"
  | "editor-interactive";

const MARKED = new Set<StartupMarkName>();

export function markStartup(name: StartupMarkName): void {
  if (MARKED.has(name)) return;
  MARKED.add(name);
  performance.mark(name);
}

export interface StartupSpan {
  readonly name: string;
  readonly durationMs: number;
}

const SPANS: ReadonlyArray<readonly [StartupMarkName, StartupMarkName, string]> = Object.freeze([
  Object.freeze<readonly [StartupMarkName, StartupMarkName, string]>(["bootstrap-start", "delivery-manifest-loaded", "startup.delivery-manifest"]),
  Object.freeze<readonly [StartupMarkName, StartupMarkName, string]>(["bootstrap-start", "studio-render-start", "startup.bootstrap-to-render"]),
  Object.freeze<readonly [StartupMarkName, StartupMarkName, string]>(["studio-render-start", "editor-interactive", "startup.render-to-interactive"]),
]);

/** Returns spans whose both marks exist; deterministic and side-effect free. */
export function measureStartupSpans(now: { getEntriesByName: typeof performance.getEntriesByName }
  = performance): readonly StartupSpan[] {
  const spans: StartupSpan[] = [];
  for (const [startMark, endMark, name] of SPANS) {
    if (!MARKED.has(startMark) || !MARKED.has(endMark)) continue;
    const starts = now.getEntriesByName(startMark);
    const ends = now.getEntriesByName(endMark);
    if (starts.length === 0 || ends.length === 0) continue;
    const start = starts[starts.length - 1]!;
    const end = ends[ends.length - 1]!;
    spans.push(Object.freeze({ name, durationMs: Math.max(0, end.startTime - start.startTime) }));
  }
  return Object.freeze(spans);
}

export function resetStartupTimelineForTest(): void {
  MARKED.clear();
}
