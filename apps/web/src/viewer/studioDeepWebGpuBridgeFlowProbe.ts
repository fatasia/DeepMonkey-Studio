export interface DeepFlowProbe {
  renderDeepFrame: number; cameraPath: number; syncPath: number; coalesced: number;
  draws: number; viewMs: number; renderMs: number; samples: string[];
  syncCount?: number; syncMs?: number; shortCircuits?: number; keyChanges?: number; demand?: unknown;
}

/** pointer→submit 链路归因探针:仅在宿主预先挂载 window.__deepFlowProbe 时
 * 按帧累计各层调用与耗时;默认零开销(一次属性读取),不影响任何行为。 */
export function flowProbe(): DeepFlowProbe | undefined {
  return (globalThis as { __deepFlowProbe?: DeepFlowProbe }).__deepFlowProbe;
}

export function recordProbeSample(probe: DeepFlowProbe, tag: string, ...values: readonly number[]): void {
  if (probe.samples.length >= 48) probe.samples.shift();
  probe.samples.push(`${tag}:${values.map(v => v.toFixed(2)).join(",")}`);
}
