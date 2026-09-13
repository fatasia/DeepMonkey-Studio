import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createDeviceSignalFixture, deviceSignalCanvasDocument } from "./deviceSignalFixture";
import { disposeViewerDeviceSignals, updateViewerDeviceSignals } from "./viewerDeviceSignals";
import { updateAnnotationVisualPresentation } from "./sceneOverlayVisuals";

/** 显式开启的 CPU 微基准，不把 Node/Canvas stub 的数据称为 GPU FPS。 */
describe.skipIf(process.env.DEVICE_SIGNAL_BENCHMARK !== "1")("device signal projection CPU benchmark", () => {
  it("compares the former per-frame path against the cache with identical signal fixtures", async () => {
    vi.stubGlobal("document", deviceSignalCanvasDocument());
    vi.stubGlobal("getComputedStyle", () => ({ getPropertyValue: () => "#ff0000" }));
    const results = [];
    try {
      for (const count of [500, 1000]) {
        const fixture = createDeviceSignalFixture(count);
        const previousEntries = new Map(fixture.entries.map(entry => [entry.id, entry]));
        try {
          for (const mode of ["static", "ten-percent-moving", "camera-moving"] as const) {
            const sample = (cached: boolean) => {
              const frames: number[] = [];
              for (let frame = 0; frame < 110; frame += 1) {
                fixture.camera.position.x = mode === "camera-moving" ? frame / 40 : 0;
                for (let index = 0; index < fixture.entries.length; index += 1) {
                  fixture.entries[index]!.target.position.y = mode === "ten-percent-moving" && index % 10 === 0 ? frame / 100 : 0;
                }
                const started = performance.now();
                if (cached) updateViewerDeviceSignals(fixture.owner, fixture.camera, 1280, 800);
                else for (const [id, entry] of previousEntries) {
                  if (!entry.target.parent) continue;
                  // 缓存前原调用链：每帧 localToWorld、clone、投影与标签展示赋值。
                  entry.visual.position.copy(entry.target.localToWorld(entry.anchor.clone()));
                  updateAnnotationVisualPresentation(`runtime-alarm:${id}`, entry.visual, fixture.camera, 1280, 800, false);
                }
                if (frame >= 10) frames.push(performance.now() - started);
              }
              return { medianMs: percentile(frames, 0.5), p95Ms: percentile(frames, 0.95), maxMs: Math.max(...frames) };
            };
            const runs = Array.from({ length: 5 }, (_, index) => {
              // 轮换测量顺序，避免把预热与单次 GC 偶然归因于优化。
              if (index % 2) { const cached = sample(true); return { baseline: sample(false), cached }; }
              return { baseline: sample(false), cached: sample(true) };
            });
            results.push({ count, mode, runs, baselineMedianMs: percentile(runs.map(run => run.baseline.medianMs), .5), cachedMedianMs: percentile(runs.map(run => run.cached.medianMs), .5) });
          }
        } finally { disposeViewerDeviceSignals(fixture.owner); }
      }
      expect(results.every(result => Number.isFinite(result.cachedMedianMs))).toBe(true);
      const destination = path.resolve(process.cwd(), "../../test-output/device-signals-projection-benchmark-0909.json");
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, JSON.stringify({ measuredAt: new Date().toISOString(), environment: { cpu: os.cpus()[0]?.model, platform: process.platform, node: process.version }, scope: "CPU transforms and annotation projection only; actual Three math, no GPU or canvas paint", framesPerRun: 100, results }, null, 2));
      console.log(JSON.stringify(results.map(({ count, mode, baselineMedianMs, cachedMedianMs }) => ({ count, mode, baselineMedianMs, cachedMedianMs })), null, 2));
    } finally { vi.unstubAllGlobals(); }
  }, 60_000);
});

function percentile(values: number[], fraction: number) { return [...values].sort((left, right) => left - right)[Math.min(values.length - 1, Math.floor(values.length * fraction))]!; }
