/**
 * 启动性能证据组装（批次 F）：把 startupTimeline 的 mark/measure 转成可采集的
 * 结构化证据（JSON 可序列化、含导航起点基准），供门禁脚本经 CDP/console 采集。
 * 纯函数 + 可注入 performance，语义与 startupTimeline.ts 单一来源对齐。
 */

import { measureStartupSpans, type StartupSpan } from "./startupTimeline.js";

export interface StartupEvidence {
  readonly schema: "deep-monkey.startup-evidence.v1";
  readonly capturedAtMs: number;
  /** 导航起点（timeOrigin）到各 mark 的毫秒偏移；未打出的 mark 不出现。 */
  readonly marks: readonly { readonly name: string; readonly offsetMs: number }[];
  /** startupTimeline 的量测段（bootstrap→render→interactive）。 */
  readonly spans: readonly StartupSpan[];
}

export function collectStartupEvidence(clock: Performance = performance,
  spans: readonly StartupSpan[] = measureStartupSpans(clock)): StartupEvidence {
  const timeOrigin = clock.timeOrigin;
  const marks = clock.getEntriesByType("mark")
    .filter(entry => entry.startTime >= 0)
    .map(entry => ({ name: entry.name, offsetMs: entry.startTime }));
  return {
    schema: "deep-monkey.startup-evidence.v1",
    capturedAtMs: Math.round(timeOrigin + clock.now()),
    marks,
    spans,
  };
}
