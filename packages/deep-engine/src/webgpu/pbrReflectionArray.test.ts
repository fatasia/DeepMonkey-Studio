import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PbrReflectionArray, composeReflectionArrayShader } from "./pbrReflectionArray.js";
import type { DeviceSession } from "./deviceSession.js";
import type { StudioEnvironment } from "./studioEnvironment.js";
import { sceneShader as PBR_SCENE_SHADER } from "./pbrShader.js";

beforeEach(() => {
  vi.stubGlobal("GPUTextureUsage", { COPY_SRC: 1, COPY_DST: 2, TEXTURE_BINDING: 4 });
  vi.stubGlobal("GPUBufferUsage", { COPY_DST: 2, UNIFORM: 64 });
});
afterEach(() => vi.unstubAllGlobals());
function fixture() {
  const copy = vi.fn(), submit = vi.fn(), write = vi.fn(), release = vi.fn();
  const cube = (size: number, levels: number) => ({ width: size, height: size, depthOrArrayLayers: 6,
    mipLevelCount: levels, format: "rgba16float", usage: 1, createView: vi.fn(() => ({})) });
  const owned = { createView: vi.fn(() => ({})) }, createTexture = vi.fn(() => owned);
  const session = { own: (resource: unknown) => resource, release, device: { createTexture,
    createBuffer: vi.fn(() => ({})), queue: { submit, writeBuffer: write }, createCommandEncoder: () => ({
      copyTextureToTexture: copy, finish: () => ({}) }) } } as unknown as DeviceSession;
  const environment = (texture: ReturnType<typeof cube>) => ({ specularTexture: texture }) as unknown as StudioEnvironment;
  return { cube, environment, session, copy, submit, write, release, createTexture, owned };
}
it("borrows the existing global cube without allocating or copying image storage", () => {
  const f = fixture(), texture = f.cube(256, 9), env = f.environment(texture), array = new PbrReflectionArray(f.session);
  const result = array.get(env);
  expect(array.get(env)).toBe(result); expect(f.createTexture).not.toHaveBeenCalled();
  expect(f.copy).not.toHaveBeenCalled(); expect(texture.createView).toHaveBeenCalledWith({ dimension: "cube-array" });
  expect(Array.from(f.write.mock.calls[0]![2])).toEqual([8,0,0,0,8,0,0,0,8,0,0,0]);
});
it("copies every original mip exactly and retains per-probe LOD ranges for unequal resolutions", () => {
  const f = fixture(), global = f.cube(256, 9), first = f.cube(128, 8), second = f.cube(64, 7);
  const env = { ...f.environment(global), reflectionProbes: [{ environment: f.environment(first) },
    { environment: f.environment(second) }] } as unknown as StudioEnvironment;
  new PbrReflectionArray(f.session).get(env);
  expect(f.createTexture).toHaveBeenCalledWith(expect.objectContaining({ size: { width:256,height:256,depthOrArrayLayers:18 }, mipLevelCount:9 }));
  expect(f.copy).toHaveBeenCalledTimes(24); expect(f.submit).toHaveBeenCalledOnce();
  expect(f.copy.mock.calls[9]).toEqual([{ texture:first,mipLevel:0 },
    { texture:f.owned,mipLevel:1,origin:[0,0,6] },[128,128,6]]);
  expect(f.copy.mock.calls[17]).toEqual([{ texture:second,mipLevel:0 },
    { texture:f.owned,mipLevel:2,origin:[0,0,12] },[64,64,6]]);
  expect(Array.from(f.write.mock.calls[0]![2])).toEqual([8,0,0,0,7,1,1,0,6,2,2,0]);
});
it("rejects a noncopyable source before making GPU allocations", () => {
  const f=fixture(), texture=f.cube(256,9); texture.usage=0;
  expect(() => new PbrReflectionArray(f.session).get(f.environment(texture))).toThrow("copyable");
  expect(f.createTexture).not.toHaveBeenCalled();
});
it("removes three sampled bindings while retaining original probe LOD semantics", () => {
  const source = composeReflectionArrayShader(PBR_SCENE_SHADER);
  expect(source).toContain("texture_cube_array<f32>");
  expect(source).not.toContain("var shadowMap:"); expect(source).not.toContain("var shadowSampler:");
  expect(source).not.toContain("primaryReflectionEnvironment"); expect(source).not.toContain("secondaryReflectionEnvironment");
  expect(source).toContain("i32(deepReflectionArrayMetadata[1].z), lod + deepReflectionArrayMetadata[1].y");
  expect(source).toContain("deepReflectionArrayMetadata[2].x");
  expect(PBR_SCENE_SHADER).toContain("var specularEnvironment: texture_cube<f32>");
});
