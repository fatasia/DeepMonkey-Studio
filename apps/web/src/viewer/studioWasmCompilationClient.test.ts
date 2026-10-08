import { afterEach, describe, expect, it, vi } from "vitest";
import type { SceneSnapshot } from "@bim-studio/contracts";
import { parseDeepRuntimePackage } from "@bim-studio/deep-engine/runtime-package";
import { compileStudioWasmRuntimePackageInProcess } from "./studioWasmRuntimePackageCompiler";
import { runStudioWasmCompilation, type StudioWasmCompilationInput,
  type StudioWasmCompilationWorker, type StudioWasmCompilationOutput } from "./studioWasmCompilationClient";

const scene: SceneSnapshot = { schemaVersion: 1, id: "worker", projectId: "project", name: "fixture",
  primitives: [{ modelId: "box", name: "Box", kind: "box", visible: true, opacity: 1, color: "#abc123",
    transform: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } } }],
  models: [], measurements: [], camera: { mode: "orbit", position: { x: 0, y: 2, z: 5 },
    target: { x: 0, y: 0, z: 0 } }, createdAt: "", updatedAt: "" };
const input: StudioWasmCompilationInput = { scene, models: [], irradianceProbes: null };
afterEach(()=>vi.useRealTimers());
function worker(): StudioWasmCompilationWorker {
  return { onmessage: null, onerror: null, postMessage: vi.fn(), terminate: vi.fn() };
}

describe("author WASM compilation ownership", () => {
  it("returns byte-identical formally validated compiler output", async () => {
    const host = worker(), controller = new AbortController();
    host.postMessage = value => {
      void compileStudioWasmRuntimePackageInProcess(structuredClone(value.scene), { models: [] },
        new AbortController().signal, value.irradianceProbes).then(bytes => host.onmessage?.(new MessageEvent("message", { data: { bytes } })));
    };
    const compiled = await runStudioWasmCompilation(input, controller.signal, () => host);
    const original = await compileStudioWasmRuntimePackageInProcess(scene, { models: [] }, controller.signal, null);
    expect(compiled.bytes).toEqual(original);
    const headerLength = new DataView(compiled.bytes.buffer).getUint32(8, true);
    const header = JSON.parse(new TextDecoder().decode(compiled.bytes.subarray(12, 12 + headerLength)));
    expect(header).toMatchObject({ schema: "deep-engine.runtime-transfer", version: 1 });
    expect(header.sections.length).toBeGreaterThan(0);
    // Internal transfer bytes are distinct from the public JSON publication.
    expect(parseDeepRuntimePackage(new TextDecoder().decode(compiled.bytes)).valid).toBe(false);
    expect(host.terminate).toHaveBeenCalledOnce();
    expect(host.onmessage).toBeNull();
  });
  it("terminates cancelled work and ignores its late result without affecting the next candidate", async () => {
    const first = worker(), second = worker(), controller = new AbortController();
    const pending = runStudioWasmCompilation(input, controller.signal, () => first);
    const stale = first.onmessage!;
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    const current = runStudioWasmCompilation(input, new AbortController().signal, () => second);
    stale(new MessageEvent("message", { data: { bytes: new Uint8Array([0]) } }));
    second.onmessage!(new MessageEvent("message", { data: { bytes: new Uint8Array([1, 2]) } }));
    expect(await current).toEqual({ bytes: new Uint8Array([1, 2]) });
    expect(first.terminate).toHaveBeenCalledOnce();
    expect(second.terminate).toHaveBeenCalledOnce();
  });
  it.each(["compiler", "transport", "postMessage"])("cleans up a %s failure", async kind => {
    const host = worker();
    if (kind === "postMessage") host.postMessage = () => { throw new Error("clone failed"); };
    const pending = runStudioWasmCompilation(input, new AbortController().signal, () => host);
    if (kind === "compiler") host.onmessage!(new MessageEvent("message", { data: { error: "hash invalid" } }));
    if (kind === "transport") host.onerror!({ message: "module missing" } as ErrorEvent);
    await expect(pending).rejects.toBeInstanceOf(Error);
    expect(host.terminate).toHaveBeenCalledOnce();
  });
  it("does not start work when already cancelled", () => {
    const create = vi.fn(worker), controller = new AbortController(); controller.abort();
    expect(() => runStudioWasmCompilation(input, controller.signal, create)).toThrow();
    expect(create).not.toHaveBeenCalled();
  });
  it("reports exact small stage messages and keeps the result as transferable owned bytes",async()=>{
    const host=worker(), progress=vi.fn();
    const pending=runStudioWasmCompilation(input,new AbortController().signal,()=>host,{onProgress:progress});
    host.onmessage!(new MessageEvent("message",{data:{kind:"progress",stage:"package"}}));
    const bytes=new Uint8Array([1,2,3]);
    host.onmessage!(new MessageEvent("message",{data:{bytes}}));
    expect(await pending).toEqual({ bytes });
    expect(progress.mock.calls.map(([event])=>event.stage)).toEqual(["starting","package"]);
  });
  it("forwards the worker-side canonical hash verbatim and rejects a malformed one",async()=>{
    const host=worker();
    const pending=runStudioWasmCompilation(input,new AbortController().signal,()=>host);
    host.onmessage!(new MessageEvent("message",{data:{bytes:new Uint8Array([1]),canonicalHash:"b".repeat(64)}}));
    expect(await pending).toEqual({bytes:new Uint8Array([1]),canonicalHash:"b".repeat(64)});
    const bad=worker();
    const rejected=runStudioWasmCompilation(input,new AbortController().signal,()=>bad);
    bad.onmessage!(new MessageEvent("message",{data:{bytes:new Uint8Array([1]),canonicalHash:"NOT-A-HASH"}}));
    await expect(rejected).rejects.toBeInstanceOf(Error);
    expect(bad.terminate).toHaveBeenCalledOnce();
  });
  it.each(["messageerror","malformed","shared","progress-callback"])("cleans up a %s protocol failure",async kind=>{
    const host=worker();
    const pending=runStudioWasmCompilation(input,new AbortController().signal,()=>host,
      {onProgress:progress=>{if(kind==="progress-callback"&&progress.stage==="package") throw new Error("sink failed");}});
    if(kind==="messageerror") host.onmessageerror!(new MessageEvent("messageerror"));
    if(kind==="malformed") host.onmessage!(new MessageEvent("message",{data:{kind:"progress",stage:"invented"}}) as unknown as MessageEvent<StudioWasmCompilationOutput>);
    if(kind==="shared") host.onmessage!(new MessageEvent("message",{data:{bytes:new Uint8Array(new SharedArrayBuffer(4))}}));
    if(kind==="progress-callback") host.onmessage!(new MessageEvent("message",{data:{kind:"progress",stage:"package"}}));
    await expect(pending).rejects.toBeInstanceOf(Error);
    expect(host.terminate).toHaveBeenCalledOnce(); expect(host.onmessageerror).toBeNull();
  });
  it("terminates a bounded job at its deadline and ignores the late result",async()=>{
    vi.useFakeTimers(); const host=worker();
    const pending=runStudioWasmCompilation(input,new AbortController().signal,()=>host,{timeoutMs:100});
    const rejected=expect(pending).rejects.toThrow("编译超时"), late=host.onmessage!;
    await vi.advanceTimersByTimeAsync(100); await rejected;
    late(new MessageEvent("message",{data:{bytes:new Uint8Array([1])}}));
    expect(host.terminate).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
  });
  it("does not post after the starting progress callback cancels the job",async()=>{
    const host=worker(), controller=new AbortController();
    const pending=runStudioWasmCompilation(input,controller.signal,()=>host,{onProgress:()=>controller.abort("cancelled")});
    await expect(pending).rejects.toBe("cancelled"); expect(host.postMessage).not.toHaveBeenCalled();
    expect(host.terminate).toHaveBeenCalledOnce();
  });
});
