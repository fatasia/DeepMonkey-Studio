import { describe, expect, it, vi } from "vitest";
import * as THREE from "three";
vi.mock("./viewerEngineRendering", () => ({ ViewerEngineRendering: class {} }));
import { ViewerEngineEnvironment } from "./viewerEngineEnvironment";

function deferred() {
  let resolve!: (texture: THREE.Texture) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<THREE.Texture>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function texture() {
  const value = new THREE.Texture(); vi.spyOn(value, "dispose"); return value;
}
function fixture() {
  const first = deferred(), second = deferred(), old = texture();
  const host = { environmentLoadRevision: 0, rendererDisposalStarted: false,
    environmentState: { skybox: "none", environmentMapUrl: "first.hdr", environmentIntensity: 0.6,
      environmentAsBackground: true, backgroundColor: "#123456" },
    lightingState: { reflectionsEnabled: true }, scene: new THREE.Scene(),
    externalEnvironmentTexture: old as THREE.Texture | undefined,
    loadEnvironmentTexture: vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise),
    getSkyboxTexture: vi.fn(), scheduleRendererPipelineWarmup: vi.fn(), requestRender: vi.fn() };
  host.scene.environment = old; host.scene.background = old;
  const apply = () => (ViewerEngineEnvironment.prototype as unknown as { applyEnvironment(): Promise<void> })
    .applyEnvironment.call(host);
  return { host, first, second, old, apply };
}

describe("author environment publication", () => {
  it("keeps the latest HDR and disposes the late older candidate", async () => {
    const f = fixture(), a = texture(), b = texture();
    const first = f.apply();
    f.host.environmentState.environmentMapUrl = "second.hdr";
    f.host.environmentState.environmentIntensity = 1.2;
    const second = f.apply();
    expect(f.old.dispose).not.toHaveBeenCalled();
    f.second.resolve(b); await second;
    f.first.resolve(a); await first;
    expect(f.host.scene.environment).toBe(b);
    expect(f.host.scene.background).toBe(b);
    expect(f.host.scene.environmentIntensity).toBe(1.2);
    expect(f.host.externalEnvironmentTexture).toBe(b);
    expect(a.dispose).toHaveBeenCalledOnce();
    expect(b.dispose).not.toHaveBeenCalled();
    expect(f.old.dispose).toHaveBeenCalledOnce();
    expect(f.host.requestRender).toHaveBeenCalledOnce();
  });
  it("ignores an old failure after a newer environment succeeds", async () => {
    const f = fixture(), b = texture();
    const first = f.apply(), second = f.apply();
    f.second.resolve(b); await second;
    f.first.reject(new Error("old failed")); await first;
    expect(f.host.scene.environment).toBe(b);
    expect(f.host.scheduleRendererPipelineWarmup).toHaveBeenCalledOnce();
  });
  it("does not publish or warm up a disposed viewer", async () => {
    const f = fixture(), a = texture();
    const pending = f.apply(); f.host.rendererDisposalStarted = true;
    f.first.resolve(a); await pending; await f.apply();
    expect(a.dispose).toHaveBeenCalledOnce();
    expect(f.host.scene.environment).toBe(f.old);
    expect(f.host.loadEnvironmentTexture).toHaveBeenCalledOnce();
    expect(f.host.requestRender).not.toHaveBeenCalled();
  });
  it("clearing the HDR supersedes an in-flight load and releases the old texture", async () => {
    const f = fixture(), a = texture();
    const pending = f.apply(); f.host.environmentState.environmentMapUrl = "";
    await f.apply(); f.first.resolve(a); await pending;
    expect(f.host.scene.environment).toBeNull();
    expect(f.host.scene.background).toBeInstanceOf(THREE.Color);
    expect(f.host.externalEnvironmentTexture).toBeUndefined();
    expect(f.old.dispose).toHaveBeenCalledOnce();
    expect(a.dispose).toHaveBeenCalledOnce();
  });
  it("preserves the existing current-request failure fallback and schedules its frame", async () => {
    const f = fixture(); const pending = f.apply();
    f.first.reject(new Error("missing")); await pending;
    expect(f.host.scene.environment).toBeNull();
    expect(f.host.scene.background).toEqual(new THREE.Color("#123456"));
    expect(f.old.dispose).toHaveBeenCalledOnce();
    expect(f.host.requestRender).toHaveBeenCalledOnce();
  });
});
