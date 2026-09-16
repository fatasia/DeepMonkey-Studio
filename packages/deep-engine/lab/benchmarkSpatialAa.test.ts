import { afterEach, describe, expect, it, vi } from "vitest";
import { PbrRenderer } from "@bim-studio/deep-engine/webgpu";
import { DeepBenchmarkBackend } from "./deepBenchmarkBackend.js";
import { createBenchmarkScene } from "./benchmarkScene.js";
import { createBenchmarkFidelitySnapshot } from "./benchmarkProfile.js";
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
describe("benchmark spatial AA fairness", () => {
  it("explicitly disables spatial and temporal AA in baseline runtime and fidelity metadata", async () => {
    vi.stubGlobal("navigator", { gpu: {} });
    const runtime = { setPacketValidated: vi.fn(async () => {}), validateFrame: vi.fn(async () => {}), dispose: vi.fn() };
    const create = vi.spyOn(PbrRenderer, "create").mockResolvedValue(runtime as unknown as PbrRenderer);
    const canvas = { width: 128, height: 64 } as HTMLCanvasElement, fixture = createBenchmarkScene(1024);
    const backend = await DeepBenchmarkBackend.create(canvas, fixture, new AbortController().signal, "baseline-equivalent");
    expect(create.mock.calls[0]![3]?.features).toMatchObject({ temporalAa: false, spatialAa: false });
    expect(create.mock.calls[0]![3]).toMatchObject({ meshlets: true, deformation: true });
    expect(backend.fidelity.categories["post-process"]).toMatchObject({ temporalAa: false, spatialAa: false });
    expect(createBenchmarkFidelitySnapshot("three-webgpu", "baseline-equivalent", fixture, canvas).categories["post-process"])
      .toEqual(backend.fidelity.categories["post-process"]);
    expect(createBenchmarkFidelitySnapshot("deep-webgpu", "high-native", fixture, canvas).categories["post-process"])
      .toMatchObject({ spatialAa: true });
    backend.dispose();
  });
});
