import { describe, expect, it, vi } from "vitest";
import { LoadingTimeline, loadingFailureOutcome, loadingTimeline, measureAssetRead } from "./loadingTimeline";
import { createRendererDiagnosticEvidence } from "./rendererDiagnosticExport";

describe("loading diagnostics", () => {
  it("records precise bounded phases once, including failures and shared wait states", () => {
    let clock = 10; const timeline = new LoadingTimeline(() => clock, 2);
    const first = timeline.begin("load-and-parse", { format: "gltf", shared: "pending" }); clock = 35; first("ok"); first("failed");
    const attach = timeline.begin("scene-attach"); clock = 40; attach("failed");
    expect(timeline.snapshot().samples).toMatchObject([{ durationMs: 25, shared: "pending", outcome: "ok" }, { durationMs: 5, outcome: "failed" }]);
    const third = timeline.begin("asset-read"); clock = 42; third("ok", 12);
    expect(timeline.snapshot()).toMatchObject({ totalStarted: 3, samples: [{ sequence: 2 }, { sequence: 3, decodedBytes: 12 }] });
    const copy = timeline.snapshot(); copy.samples[0]!.durationMs = 999;
    expect(timeline.snapshot().samples[0]?.durationMs).toBe(5);
  });

  it("preserves transport failure semantics and exposes phases in the existing diagnostic export", async () => {
    const error = new DOMException("aborted private-url", "AbortError");
    await expect(measureAssetRead(async () => { throw error; })).rejects.toBe(error);
    const result = await measureAssetRead(async () => new ArrayBuffer(7)); expect(result.byteLength).toBe(7);
    expect(loadingTimeline.snapshot().samples.slice(-2)).toMatchObject([{ outcome: "cancelled" }, { decodedBytes: 7 }]);
    expect(loadingFailureOutcome(Object.assign(new Error(), { name: "ModelLoadSupersededError" }))).toBe("cancelled");
    const exported = createRendererDiagnosticEvidence({ current: "webgl", performance: undefined, probe: undefined, readiness: [] }, "time", "browser");
    expect(exported.loadingTimeline.samples.at(-1)?.decodedBytes).toBe(7);
    expect(exported.browserInput.scope).toBe("document-first-input");
    expect(JSON.stringify(exported)).not.toContain("private-url");
  });
});
