import { describe, expect, it } from "vitest";
import { decodeRadianceHdr } from "../textures/radianceHdr.js";
import { createPathTraceCpuKernel } from "./pathTraceCpuKernel.js";
import { PathTraceCpuRender } from "./pathTraceCpuRender.js";
import type { PathTraceRgb } from "./pathTraceCpuTypes.js";

const config = { width: 2, height: 2, maxSamples: 256, minSamples: 4,
  varianceThreshold: 0.05, maxAccumulationBytes: 96, sampleSeed: 0xffffffff };
const identity = { sceneRevision: 1, materialHash: "mat-1", cameraHash: "cam-1" };
function kernel(environment: PathTraceRgb | ((d: PathTraceRgb) => PathTraceRgb) = [1, 2, 4]) {
  return createPathTraceCpuKernel({ width: 2, height: 2,
    blas: { id: "empty", vertices: new Float32Array(), indices: new Uint32Array() }, materials: [],
    camera: { origin: [0, 0, 0], target: [0, 0, -1], up: [0, 1, 0], verticalFovDegrees: 60 }, environment });
}
describe("CPU path trace product consumption", () => {
  it("accumulates real pixels and roundtrips converged HDR before releasing the lease", () => {
    const render = new PathTraceCpuRender(config);
    expect(render.begin(identity, kernel()).status).toBe("started");
    expect(render.session.residentBytes).toBe(96);
    expect(() => render.exportHdr()).toThrow(/convergence/);
    expect(render.advance(4).converged).toBe(true);
    const { bytes, receipt } = render.exportHdr();
    expect(receipt.sampleCount).toBe(4); expect(receipt.seed).toBe(0xffffffff);
    expect([...decodeRadianceHdr(bytes).data]).toEqual([1, 2, 4, 1, 2, 4, 1, 2, 4, 1, 2, 4]);
    expect(render.session.residentBytes).toBe(0); expect(() => render.image()).toThrow();
    render.dispose(); render.dispose();
  });
  it("is bitwise identical across batch partitioning", () => {
    const environment = (d: PathTraceRgb): PathTraceRgb => [Math.abs(d[0]), Math.abs(d[1]), Math.abs(d[2])];
    const a = new PathTraceCpuRender(config), b = new PathTraceCpuRender(config);
    a.begin(identity, kernel(environment)); b.begin(identity, kernel(environment));
    a.advance(32); b.advance(3); b.advance(7); b.advance(22);
    expect(a.image().data).toEqual(b.image().data);
    expect(a.session.sampleCount).toBe(32); expect(b.session.sampleCount).toBe(32);
    a.dispose(); b.dispose();
  });
  it.each(["materialHash", "cameraHash", "sceneRevision"] as const)("resets real pixels when %s changes", field => {
    const render = new PathTraceCpuRender(config);
    render.begin(identity, kernel()); render.advance(4);
    const previousGeneration = render.session.generation;
    const next = { ...identity, [field]: field === "sceneRevision" ? 2 : "changed" };
    render.begin(next, kernel([0.5, 0.25, 0.125]));
    expect(render.session.sampleCount).toBe(0); expect(render.session.converged).toBe(false);
    expect(render.session.generation).toBeGreaterThan(previousGeneration);
    expect(() => render.image()).toThrow();
    render.advance(4); expect([...render.image().data].slice(0, 3)).toEqual([0.5, 0.25, 0.125]);
    render.dispose();
  });
  it("refuses kernel replacement without a changed scene identity", () => {
    const render = new PathTraceCpuRender(config), reference = kernel();
    render.begin(identity, reference); render.advance(1);
    expect(render.begin(identity, reference).status).toBe("unchanged");
    expect(() => render.begin(identity, kernel())).toThrow(/identity/);
    render.dispose();
  });
  it("drops a partly evaluated cancelled batch and releases its actual buffers", () => {
    const render = new PathTraceCpuRender(config), controller = new AbortController();
    let calls = 0;
    render.begin(identity, kernel(() => {
      if (++calls === 3) controller.abort();
      return [1, 1, 1];
    }));
    expect(render.advance(8, controller.signal).status).toBe("cancelled");
    expect(calls).toBe(3); expect(render.session.sampleCount).toBe(0);
    expect(render.session.residentBytes).toBe(0); expect(() => render.image()).toThrow();
    expect(() => render.exportHdr()).toThrow(); render.dispose();
  });
  it("prevents publication when a callback changes the active generation", () => {
    const render = new PathTraceCpuRender(config);
    render.begin(identity, kernel(() => {
      render.begin({ ...identity, materialHash: "next" }, kernel([9, 9, 9]));
      return [1, 1, 1];
    }));
    expect(() => render.advance(1)).toThrow(/generation/);
    expect(render.session.sampleCount).toBe(0); expect(() => render.image()).toThrow(); render.dispose();
  });
  it("rejects budgets without allocating and sample caps without altering pixels", () => {
    const rejected = new PathTraceCpuRender({ ...config, maxAccumulationBytes: 95 });
    expect(rejected.begin(identity, kernel()).status).toBe("rejected-budget");
    expect(rejected.session.residentBytes).toBe(0); rejected.dispose();
    const render = new PathTraceCpuRender(config);
    render.begin(identity, kernel()); render.advance(1); const before = render.image().data;
    expect(render.advance(256).status).toBe("rejected-limit");
    expect(render.image().data).toEqual(before); render.dispose();
  });
  it("fails closed for invalid sample radiance and releases memory", () => {
    const render = new PathTraceCpuRender(config);
    render.begin(identity, kernel(() => [NaN, 0, 0]));
    expect(() => render.advance(1)).toThrow(/environment/);
    expect(render.session.residentBytes).toBe(0); render.dispose();
  });
  it("rejects HDR when pixel noise cancels out in the global average", () => {
    const render = new PathTraceCpuRender(config);
    render.begin(identity, { traceSample: (x, _y, ordinal) => {
      const value = (x + ordinal) % 2 === 0 ? 0 : 2;
      return [value, value, value];
    } });
    render.advance(4);
    expect(render.session.converged).toBe(true); expect(render.converged).toBe(false);
    expect(render.maxRelativeStandardError).toBeGreaterThan(0.5);
    expect(() => render.exportHdr()).toThrow(/per-pixel/); render.dispose();
  });
  it("accepts actual scheduler cancellation and never evaluates later samples", async () => {
    const render = new PathTraceCpuRender(config), controller = new AbortController();
    let yields = 0;
    render.begin(identity, kernel());
    const outcome = await render.advanceAsync(8, async () => { yields++; controller.abort(); }, controller.signal);
    expect(outcome.status).toBe("cancelled"); expect(yields).toBe(1);
    expect(render.session.sampleCount).toBe(1); expect(render.session.residentBytes).toBe(0);
    expect(() => render.image()).toThrow(); render.dispose();
  });
  it("refuses async work from an earlier generation after scheduler invalidation", async () => {
    const render = new PathTraceCpuRender(config);
    render.begin(identity, kernel());
    await expect(render.advanceAsync(8, async () => {
      render.begin({ ...identity, materialHash: "async-next" }, kernel([9, 9, 9]));
    })).rejects.toThrow(/generation/);
    expect(render.session.sampleCount).toBe(0); expect(() => render.image()).toThrow();
    render.advance(4); expect([...render.image().data].slice(0, 3)).toEqual([9, 9, 9]); render.dispose();
  });
  it("converges and exports actual diffuse path samples against the analytic integral", () => {
    const render = new PathTraceCpuRender({ ...config, width: 1, height: 1, maxSamples: 4096,
      minSamples: 64, varianceThreshold: 0.02, sampleSeed: 17, maxAccumulationBytes: 24 });
    const diffuse = createPathTraceCpuKernel({ width: 1, height: 1,
      blas: { id: "diffuse", vertices: new Float32Array([-1e6, -1e6, 0, 1e6, -1e6, 0, 0, 1e6, 0]),
        indices: new Uint32Array([0, 1, 2]) }, materials: [{ model: "lambert", reflectance: [1, 1, 1] }],
      camera: { origin: [0, 0, 1], target: [0, 0, 0], up: [0, 1, 0], verticalFovDegrees: 0.001 },
      environment: d => [d[2] ** 2, d[2] ** 2, d[2] ** 2], rouletteStart: 64 });
    render.begin(identity, diffuse); expect(render.advance(16).converged).toBe(false);
    expect(render.advance(4080).converged).toBe(true);
    expect(Math.abs(render.image().data[0]! - 0.5)).toBeLessThan(0.01);
    const { bytes, receipt } = render.exportHdr();
    expect(receipt.sampleCount).toBe(4096);
    expect(Math.abs(decodeRadianceHdr(bytes).data[0]! - 0.5)).toBeLessThan(0.012); render.dispose();
  });
});
