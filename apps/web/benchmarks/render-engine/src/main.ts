import "./benchmark.css";
import type { BenchmarkEngine, BenchmarkWorkload, RenderBenchmarkControl, RenderBenchmarkRuntime } from "./contracts";
import { waitForFrames } from "./frameSampler";

const params = new URLSearchParams(location.search);
const requestedEngine = (params.get("engine") ?? "three-webgl") as BenchmarkEngine;
const workload: BenchmarkWorkload = params.get("workload") === "dynamic" ? "dynamic" : "static";
const objectCount = Math.max(1, Math.min(10_000, Number(params.get("count") ?? 120)));
const canvas = document.querySelector<HTMLCanvasElement>("#viewport")!;
const status = document.querySelector<HTMLOutputElement>("#status")!;
const startedAt = performance.now();

void createRuntime(requestedEngine, workload, canvas, objectCount, startedAt).then(async (runtime) => {
  await waitForFrames(180);
  const control: RenderBenchmarkControl = {
    ready: true,
    snapshot: runtime.snapshot(),
    async rebuild(cycle) {
      await runtime.rebuild(cycle);
      await waitForFrames(6);
      return runtime.snapshot();
    },
  };
  window.__renderEngineBenchmark = control;
  status.textContent = `${requestedEngine}\n${workload} · ${objectCount} objects`;
  window.addEventListener("beforeunload", () => runtime.dispose(), { once: true });
}).catch((reason) => {
  const error = reason instanceof Error ? reason.message : String(reason);
  window.__renderEngineBenchmark = { ready: false, error, async rebuild() { throw new Error(error); } };
  status.textContent = error;
});

async function createRuntime(engine: BenchmarkEngine, workload: BenchmarkWorkload, target: HTMLCanvasElement, count: number, initializedAt: number): Promise<RenderBenchmarkRuntime> {
  if (engine === "three-webgl") return (await import("./threeWebglRuntime")).createThreeWebglRuntime(target, count, initializedAt, workload);
  return (await import("./threeWebgpuRuntime")).createThreeWebgpuRuntime(target, count, initializedAt, workload);
}
