import { describe, expect, it, vi } from "vitest";
import { preparePbrReflectionProbes, snapshotPbrReflectionProbeSources } from "./pbrReflectionProbePreparation.js";
import { compileReflectionProbePrefilter, createReflectionProbeSpecularEnvironment } from "./reflectionProbeSpecularEnvironment.js";
import type { StudioEnvironment } from "./studioEnvironment.js";
vi.mock("./reflectionProbeSpecularEnvironment.js", () => ({ compileReflectionProbePrefilter: vi.fn(async () => ({})), createReflectionProbeSpecularEnvironment: vi.fn() }));
const box = { center: [0, 2, 0] as const, halfExtents: [3, 2, 3] as const, blendDistance: 1, influenceRadius: 2 };
const image = () => ({ width: 2, height: 1, data: new Float32Array([1, 2, 3, 4, 5, 6]) });
function environment() { return { specular: {}, diffuse: {}, brdf: {}, sampler: {}, dispose: vi.fn() } as unknown as StudioEnvironment & { dispose: ReturnType<typeof vi.fn> }; }
describe("bounded reflection probe candidate preparation", () => {
  it("takes a frozen validated author record before asynchronous work", () => {
    const sources = [{ box: { ...box, center: [...box.center] }, image: image() }];
    const snapshot = snapshotPbrReflectionProbeSources(sources); sources[0]!.box.center[0] = 99;
    expect(snapshot?.[0]?.box.center[0]).toBe(0); expect(Object.isFrozen(snapshot?.[0]?.box)).toBe(true);
    expect(() => snapshotPbrReflectionProbeSources([sources[0]!, sources[0]!, sources[0]!])).toThrow("two");
  });
  it("shares two identical probe images and a single pipeline without a global cache", async () => {
    vi.clearAllMocks(); const base = environment(), local = environment(), pixels = image();
    vi.mocked(createReflectionProbeSpecularEnvironment).mockResolvedValue(local as never);
    const combined = await preparePbrReflectionProbes({} as never, base, [{ box, image: pixels }, { box, image: pixels }], new AbortController().signal);
    expect(compileReflectionProbePrefilter).toHaveBeenCalledOnce(); expect(createReflectionProbeSpecularEnvironment).toHaveBeenCalledOnce();
    expect(combined.reflectionProbes?.[0]?.environment).toBe(combined.reflectionProbes?.[1]?.environment);
    combined.dispose(); expect(base.dispose).toHaveBeenCalledOnce(); expect(local.dispose).toHaveBeenCalledOnce();
  });
  it("aliases the base pixels without compiling or uploading and owns their base only once", async () => {
    vi.clearAllMocks(); const base = environment(), pixels = image();
    const combined = await preparePbrReflectionProbes({} as never, base, [{ box }, { box, image: pixels }], new AbortController().signal, pixels);
    expect(compileReflectionProbePrefilter).not.toHaveBeenCalled(); expect(createReflectionProbeSpecularEnvironment).not.toHaveBeenCalled();
    combined.dispose(); expect(base.dispose).toHaveBeenCalledOnce();
  });
  it("rolls back all candidate owners after a later probe preparation fails", async () => {
    vi.clearAllMocks(); const base = environment(), local = environment();
    vi.mocked(createReflectionProbeSpecularEnvironment).mockResolvedValueOnce(local as never).mockRejectedValueOnce(new Error("second probe failed"));
    await expect(preparePbrReflectionProbes({} as never, base, [{ box, image: image() }, { box, image: image() }], new AbortController().signal)).rejects.toThrow("second probe failed");
    expect(base.dispose).toHaveBeenCalledOnce(); expect(local.dispose).toHaveBeenCalledOnce();
  });
  it("does not publish old device owners after a ready replacement epoch", async () => {
    vi.clearAllMocks(); const base = environment(), local = environment();
    const session = { device: {} };
    vi.mocked(createReflectionProbeSpecularEnvironment).mockImplementationOnce(async () => {
      session.device = { replacement: true }; return local as never;
    });
    await expect(preparePbrReflectionProbes(session as never, base, [{ box, image: image() }], new AbortController().signal)).rejects.toThrow("epoch");
    expect(base.dispose).toHaveBeenCalledOnce(); expect(local.dispose).toHaveBeenCalledOnce();
  });
});
