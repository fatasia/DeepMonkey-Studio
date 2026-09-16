import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRuntimeIblFixture } from "../../scripts/runtimePackageIblFixture.mjs";
import type { RuntimePrefilteredIbl } from "../runtimePackage/environmentTypes.js";
import { createPbrEnvironment } from "./pbrEnvironmentSource.js";
import type { DeviceSession } from "./deviceSession.js";

function fixture() {
  const owned = new Set<any>(), allocated: any[] = [];
  const device = { limits: { maxTextureDimension2D: 2048 }, pushErrorScope: vi.fn(),
    popErrorScope: vi.fn(async () => null as GPUError | null),
    queue: { writeTexture: vi.fn(), onSubmittedWorkDone: vi.fn(async () => {}) },
    createSampler: vi.fn(() => ({})), createTexture: vi.fn((descriptor: GPUTextureDescriptor) => {
      const texture = { descriptor, destroy: vi.fn(), createView: vi.fn(() => ({})) }; allocated.push(texture); return texture;
    }) };
  const raw = { state: "ready", device, own: (resource: any) => { owned.add(resource); return resource; },
    release: (resource: any) => { if (owned.delete(resource)) resource.destroy(); } };
  return { raw, session: raw as unknown as DeviceSession, device, owned, allocated };
}
const input = () => ({ kind: "prefiltered-ibl" as const, environment: createRuntimeIblFixture() as RuntimePrefilteredIbl });
beforeEach(() => vi.stubGlobal("GPUTextureUsage", { TEXTURE_BINDING: 1, COPY_DST: 2 }));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
describe("prefiltered IBL production source", () => {
  it("uploads exact offline half bytes and all mips without compute generation", async () => {
    const f = fixture(), source = input();
    const environment = await createPbrEnvironment(f.session, source, new AbortController().signal);
    expect(f.allocated).toHaveLength(3); expect(f.device.queue.writeTexture).toHaveBeenCalledTimes(4);
    expect(f.allocated[0].descriptor).toMatchObject({ format: "rgba16float", mipLevelCount: 2, size: [2, 2, 6] });
    const first = f.device.queue.writeTexture.mock.calls[0]!;
    expect([...first[1]]).toEqual([...Buffer.from(source.environment.specular.mips[0]!.dataBase64, "base64")]);
    expect(first[2]).toEqual({ bytesPerRow: 16, rowsPerImage: 2 });
    expect(f.device.pushErrorScope).toHaveBeenCalledTimes(3); expect(f.device.popErrorScope).toHaveBeenCalledTimes(3);
    environment.dispose(); environment.dispose(); expect(f.owned.size).toBe(0);
    expect(f.allocated.every(value => value.destroy.mock.calls.length === 1)).toBe(true);
  });
  it("rejects malformed and oversized inputs before allocating textures", async () => {
    const f = fixture(), bad = input(); bad.environment = { ...bad.environment, format: "rgba32float" as never };
    await expect(createPbrEnvironment(f.session, bad, new AbortController().signal)).rejects.toThrow("profile");
    f.device.limits.maxTextureDimension2D = 1;
    await expect(createPbrEnvironment(f.session, input(), new AbortController().signal)).rejects.toThrow("dimension");
    expect(f.allocated).toHaveLength(0);
  });
  it.each(["upload", "scope", "completion", "view"])("rolls back all textures on %s failure", async fault => {
    const f = fixture();
    if (fault === "upload") f.device.queue.writeTexture.mockImplementationOnce(() => { throw Error("upload fault"); });
    if (fault === "scope") f.device.popErrorScope.mockResolvedValueOnce({ message: "scope fault" } as GPUError);
    if (fault === "completion") f.device.queue.onSubmittedWorkDone.mockImplementationOnce(() => { throw Error("completion fault"); });
    if (fault === "view") f.device.createSampler.mockImplementationOnce(() => { throw Error("view fault"); });
    await expect(createPbrEnvironment(f.session, input(), new AbortController().signal)).rejects.toThrow("fault");
    expect(f.owned.size).toBe(0); expect(f.allocated.every(value => value.destroy.mock.calls.length === 1)).toBe(true);
  });
  it("aborts a pending completion and never exposes its textures", async () => {
    const f = fixture(), controller = new AbortController(); let finish!: () => void;
    f.device.queue.onSubmittedWorkDone.mockReturnValueOnce(new Promise<void>(resolve => { finish = resolve; }));
    const pending = createPbrEnvironment(f.session, input(), controller.signal);
    controller.abort(Error("cancelled by author"));
    await expect(pending).rejects.toThrow("cancelled by author");
    expect(f.owned.size).toBe(0); finish();
  });
  it("does not allocate for pre-cancelled requests or lost sessions", async () => {
    const f = fixture(), controller = new AbortController(); controller.abort(Error("pre-cancelled"));
    await expect(createPbrEnvironment(f.session, input(), controller.signal)).rejects.toThrow("pre-cancelled");
    f.raw.state = "lost";
    await expect(createPbrEnvironment(f.session, input(), new AbortController().signal)).rejects.toThrow("not ready");
    expect(f.allocated).toHaveLength(0); expect(f.device.pushErrorScope).not.toHaveBeenCalled();
  });
  it("rejects a device loss between upload and publication and releases every texture", async () => {
    const f = fixture();
    f.device.queue.onSubmittedWorkDone.mockImplementationOnce(async () => { f.raw.state = "lost"; });
    await expect(createPbrEnvironment(f.session, input(), new AbortController().signal)).rejects.toThrow("session changed");
    expect(f.owned.size).toBe(0);
    expect(f.allocated.every(value => value.destroy.mock.calls.length === 1)).toBe(true);
    expect(f.device.popErrorScope).toHaveBeenCalledTimes(3);
  });
  it("snapshots all mip bytes before a reentrant upload callback mutates caller input", async () => {
    const f = fixture(), source = input(), expected = source.environment.specular.mips[1]!.dataBase64;
    f.device.queue.writeTexture.mockImplementationOnce(() => {
      (source.environment.specular.mips[1] as { dataBase64: string }).dataBase64 = "changed by caller";
    });
    const environment = await createPbrEnvironment(f.session, source, new AbortController().signal);
    expect([...f.device.queue.writeTexture.mock.calls[1]![1]]).toEqual([...Buffer.from(expected, "base64")]);
    environment.dispose(); expect(f.owned.size).toBe(0);
  });
  it("releases remaining textures when one destroy throws", async () => {
    const f = fixture(), environment = await createPbrEnvironment(f.session, input(), new AbortController().signal);
    f.allocated[0].destroy.mockImplementationOnce(() => { throw Error("destroy fault"); });
    expect(() => environment.dispose()).toThrow(); expect(f.owned.size).toBe(0);
    expect(() => environment.dispose()).not.toThrow();
  });
});
