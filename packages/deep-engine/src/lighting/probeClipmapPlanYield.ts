import type { ProbeClipmapPlan } from "./probeClipmapPlan.js";

export async function resumeProbePlan(work: Generator<void, ProbeClipmapPlan>, signal?: AbortSignal): Promise<ProbeClipmapPlan> {
  try {
    for (;;) {
      if (signal?.aborted) throw signal.reason ?? Object.assign(new Error("Probe plan cancelled."), { name: "AbortError" });
      await yieldProbePlan();
      if (signal?.aborted) throw signal.reason ?? Object.assign(new Error("Probe plan cancelled."), { name: "AbortError" });
      const step = work.next();
      if (step.done) return step.value;
    }
  } finally { work.return(undefined as never); }
}
export function yieldProbePlan(): Promise<void> {
  const scheduling = (globalThis as typeof globalThis & { scheduler?: { yield(): Promise<void> } }).scheduler;
  if (scheduling?.yield) return scheduling.yield();
  // Node-only consumers do not include DOM MessagePort declarations.
  const Channel = (globalThis as unknown as { MessageChannel?: new () => {
    port1: { onmessage: (() => void) | null; close(): void };
    port2: { postMessage(value: unknown): void; close(): void };
  } }).MessageChannel;
  if (!Channel) return new Promise(resolve => setTimeout(resolve, 0));
  return new Promise(resolve => {
    const channel = new Channel();
    channel.port1.onmessage = () => { channel.port1.close(); channel.port2.close(); resolve(); };
    channel.port2.postMessage(null);
  });
}
