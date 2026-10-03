import { afterEach, describe, expect, it, vi } from "vitest";
import { PbrMainBindings } from "./pbrMainBindings.js";
import type { DeviceSession } from "./deviceSession.js";
import type { Pipelines } from "./pipelines.js";
import type { StudioEnvironment } from "./studioEnvironment.js";
import type { CascadedShadowResources } from "./cascadedShadowResources.js";
import { sceneShader } from "./pbrShader.js";
import { readFileSync } from "node:fs";

afterEach(() => vi.unstubAllGlobals());
function fixture() {
  vi.stubGlobal("GPUBufferUsage", { UNIFORM: 1, COPY_DST: 2 });
  vi.stubGlobal("GPUTextureUsage", { TEXTURE_BINDING: 16 });
  const buffer = {} as GPUBuffer, writeBuffer = vi.fn(), createBindGroup = vi.fn(() => ({} as GPUBindGroup));
  const release = vi.fn(), createBuffer = vi.fn(() => buffer);
  const session = { device: { createBuffer, createTexture: vi.fn(() => ({ createView: () => ({}) } as unknown as GPUTexture)), createSampler: vi.fn(() => ({} as GPUSampler)), queue: { writeBuffer }, createBindGroup },
    own: (value: GPUBuffer) => value, release } as unknown as DeviceSession;
  const pipelines = { main: { getBindGroupLayout: () => ({}) } } as unknown as Pipelines;
  const environment = { specular: {}, diffuse: {}, brdf: {}, sampler: {} } as StudioEnvironment;
  const create = () => new PbrMainBindings(session, pipelines, {} as GPUBuffer, {} as CascadedShadowResources, environment);
  return { buffer, createBuffer, writeBuffer, createBindGroup, release, environment, create };
}
const lights = { ambient: [{ color: [1, 0.5, 0.25] as const, intensity: 2 }] };
const probeBox = { center: [0, 2, 0] as const, halfExtents: [3, 2, 3] as const, blendDistance: 1, influenceRadius: 2 };

describe("PBR bounded reflection bindings", () => {
  it("atomically replaces mip offsets and restores them with a previous environment", () => {
    const f = fixture(), bindings = f.create(); f.writeBuffer.mockClear();
    bindings.setEnvironment({ ...f.environment, specularMipSelection: { rawMips: 8, keptMips: 4, droppedMips: 4 } });
    expect([...((f.writeBuffer.mock.calls.at(-1)![2]) as Float32Array).slice(12, 15)]).toEqual([4, 4, 4]);
    bindings.setEnvironment(f.environment);
    expect([...((f.writeBuffer.mock.calls.at(-1)![2]) as Float32Array).slice(12, 15)]).toEqual([0, 0, 0]);
  });
  it("aliases both empty cubemap slots and publishes an actual probe with only an inactive record upload", () => {
    const f = fixture();
    let next = 0;
    f.createBuffer.mockImplementation(() => ({ label: `buffer-${next++}` }) as GPUBuffer);
    const bindings = f.create();
    const initial = Array.from((f.createBindGroup.mock.calls[0]![0] as GPUBindGroupDescriptor).entries);
    expect(initial.find(entry => entry.binding === 9)?.resource).toBe(f.environment.specular);
    expect(initial.find(entry => entry.binding === 10)?.resource).toBe(f.environment.specular);
    const active = (initial.find(entry => entry.binding === 11)!.resource as GPUBufferBinding).buffer;
    const local = { ...f.environment, specular: { label: "local-probe" } } as StudioEnvironment;
    f.writeBuffer.mockClear();
    bindings.setEnvironment({ ...f.environment, reflectionProbes: [{ box: probeBox, environment: local }] });
    const latest = Array.from((f.createBindGroup.mock.calls.at(-1)![0] as GPUBindGroupDescriptor).entries);
    expect(latest.find(entry => entry.binding === 9)?.resource).toBe(local.specular);
    expect(latest.find(entry => entry.binding === 10)?.resource).toBe(f.environment.specular);
    const candidate = (latest.find(entry => entry.binding === 11)!.resource as GPUBufferBinding).buffer;
    expect(candidate).not.toBe(active); expect(f.writeBuffer).toHaveBeenCalledOnce();
    expect(f.writeBuffer.mock.calls[0]![0]).toBe(candidate);
    expect(f.createBuffer).toHaveBeenCalledTimes(4);
  });

  it("keeps the previous binding and active records after candidate upload failure, then retries the same inactive buffer", () => {
    const f = fixture(); let next = 0;
    f.createBuffer.mockImplementation(() => ({ label: `buffer-${next++}` }) as GPUBuffer);
    const bindings = f.create(), active = bindings.binding;
    f.writeBuffer.mockClear(); f.writeBuffer.mockImplementationOnce(() => { throw new Error("record upload rejected"); });
    expect(() => bindings.setEnvironment(f.environment)).toThrow("record upload rejected");
    expect(bindings.binding).toBe(active);
    const failed = f.writeBuffer.mock.calls[0]![0]; bindings.setEnvironment(f.environment);
    expect(f.writeBuffer.mock.calls[1]![0]).toBe(failed);
    expect(bindings.binding).not.toBe(active);
    expect(f.createBuffer).toHaveBeenCalledTimes(4);
  });
});

describe("PBR authored diffuse binding", () => {
  it("binds replacement shadows against the latest environment and preserves active state on failure", () => {
    const f = fixture(), bindings = f.create();
    const shadows = { legacyView: {}, sampler: {} } as CascadedShadowResources;
    const latest = { ...f.environment, specular: { label: "latest" } } as StudioEnvironment;
    bindings.setShadows(shadows, latest);
    const entries = Array.from((f.createBindGroup.mock.calls.at(-1)![0] as GPUBindGroupDescriptor).entries);
    expect(entries.find(entry => entry.binding === 1)?.resource).toBe(shadows.legacyView);
    expect(entries.find(entry => entry.binding === 3)?.resource).toBe(latest.specular);
    const active = bindings.binding;
    f.createBindGroup.mockImplementationOnce(() => { throw new Error("bind"); });
    expect(() => bindings.setShadows({} as CascadedShadowResources, latest)).toThrow("bind");
    expect(bindings.binding).toBe(active);
    bindings.setEnvironment(latest);
    expect(Array.from((f.createBindGroup.mock.calls.at(-1)![0] as GPUBindGroupDescriptor).entries)
      .find(entry => entry.binding === 1)?.resource).toBe(shadows.legacyView);
  });
  it("uploads changes once and clears disabled lights without touching environment state", () => {
    const f = fixture(), bindings = f.create();
    expect(bindings.update(lights)).toBe(true); expect(bindings.update(lights)).toBe(false);
    expect(f.writeBuffer).toHaveBeenCalledTimes(5);
    expect(f.createBindGroup).toHaveBeenCalledTimes(1);
    bindings.update();
    expect(f.writeBuffer).toHaveBeenCalledTimes(6);
    expect(f.writeBuffer.mock.calls[5]![2]).toEqual(new Float32Array(16));
  });
  it("reuses the diffuse resource across environment replacement", () => {
    const f = fixture(), bindings = f.create();
    bindings.update(lights); bindings.setEnvironment(f.environment);
    expect(f.createBindGroup).toHaveBeenCalledTimes(2);
    const descriptor = f.createBindGroup.mock.calls[1]![0] as GPUBindGroupDescriptor;
    expect(Array.from(descriptor.entries).find(entry => entry.binding === 7)?.resource).toEqual({ buffer: f.buffer });
  });
  it("does not accept failed upload state and retries the identical update", () => {
    const f = fixture(), bindings = f.create();
    f.writeBuffer.mockImplementationOnce(() => { throw new Error("lost"); });
    expect(() => bindings.update(lights)).toThrow("lost");
    bindings.update(lights);
    expect(f.writeBuffer).toHaveBeenCalledTimes(6);
  });
  it("releases the owned buffer if binding creation fails", () => {
    const f = fixture();
    f.createBindGroup.mockImplementationOnce(() => { throw new Error("binding"); });
    expect(f.create).toThrow("binding");
    expect(f.release).toHaveBeenCalledTimes(4);
    expect(f.release).toHaveBeenCalledWith(f.buffer);
  });
  it("applies diffuse outside the IBL gate in HDR, transparent and direct paths", () => {
    expect(sceneShader).toContain("@group(0) @binding(7) var<uniform> deepDiffuse");
    expect(sceneShader).toContain("color += deepAuthoredDiffuse(n, base, metal, occlusionInput)");
    expect(sceneShader.match(/deepAuthoredDiffuse\(n, base, metal, 1\.0\)/g)).toHaveLength(2);
    expect(sceneShader).toContain("/ 3.141592653589793");
  });
  it("invalidates temporal history only after an environment is actually published", () => {
    const source = readFileSync(new URL("./pbrRenderer.ts", import.meta.url), "utf8");
    expect(source).toContain("if (this.environment.beginFrame(candidate => this.mainBindings.setEnvironment(candidate))) this.historyDirty = true;");
    expect(source).toContain("this.environment.runFrame(() => this.renderPreparedFrame(view), previous => this.mainBindings.setEnvironment(previous))");
    expect(source).toContain("if (this.mainBindings.update(view.lights, view.fog)) this.historyDirty = true;");
  });

  it("does not publish replacement shadow resources before the zero-size frame guard", () => {
    const source = readFileSync(new URL("./pbrRenderer.ts", import.meta.url), "utf8");
    // F4 超分尺寸决策后 guard 变量为画布 surface(渲染 size 由其派生),guard 语义不变。
    const guard = source.indexOf("if (!surface) return undefined;");
    const publication = source.indexOf("this.shadowState.publish(");
    expect(guard).toBeGreaterThan(0);
    expect(publication).toBeGreaterThan(guard);
    expect(publication).toBeLessThan(source.indexOf("updatePbrFrameUniforms(this.session.device.queue"));
  });

  it("binds 32-byte fog settings and distinguishes legacy, explicit off and authored updates", () => {
    const f = fixture(), bindings = f.create();
    expect(Array.from((f.createBindGroup.mock.calls[0]![0] as GPUBindGroupDescriptor).entries)
      .find(entry => entry.binding === 8)?.resource).toEqual({ buffer: f.buffer });
    expect(f.writeBuffer.mock.calls[1]![2]).toEqual(new Float32Array([0, 0, 0, 3, 0, 0, 0, 0]));
    expect(bindings.update(undefined, null)).toBe(true);
    expect(bindings.update(undefined, null)).toBe(false);
    const fog = { kind: "linear" as const, color: [1, 2, 3] as const, near: 10, far: 20 };
    expect(bindings.update(undefined, fog)).toBe(true);
    expect(f.writeBuffer.mock.calls.at(-1)![2]).toEqual(new Float32Array([1, 2, 3, 1, 10, 20, 0, 0]));
    expect(bindings.update(undefined, { ...fog })).toBe(false);
    expect(bindings.update()).toBe(true);
  });

  it("validates fog before either upload and retries both buffers after a partial write failure", () => {
    const f = fixture(), bindings = f.create(); f.writeBuffer.mockClear();
    expect(() => bindings.update(lights, { kind: "exp2", color: [0, 0, 0], density: NaN })).toThrow();
    expect(f.writeBuffer).not.toHaveBeenCalled();
    f.writeBuffer.mockImplementationOnce(() => {}).mockImplementationOnce(() => { throw new Error("fog upload"); });
    expect(() => bindings.update(lights, null)).toThrow("fog upload");
    expect(bindings.update(lights, null)).toBe(true);
    expect(f.writeBuffer).toHaveBeenCalledTimes(4);
    expect(bindings.update(lights, null)).toBe(false);
  });

  it("releases diffuse allocation when the new fog buffer cannot be allocated", () => {
    const f = fixture();
    f.createBuffer.mockImplementationOnce(() => f.buffer).mockImplementationOnce(() => { throw new Error("fog allocation"); });
    expect(f.create).toThrow("fog allocation");
    expect(f.release).toHaveBeenCalledExactlyOnceWith(f.buffer);
    expect(f.createBindGroup).not.toHaveBeenCalled();
  });
});
