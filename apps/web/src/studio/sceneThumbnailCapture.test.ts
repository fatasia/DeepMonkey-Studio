import { afterEach, describe, expect, it, vi } from "vitest";
import { captureSceneThumbnailAsync } from "./sceneThumbnailCapture";
import type { ViewerEngine } from "../viewer/ViewerEngine";

function fixture() {
  let frame: (() => void) | undefined;
  const dispose = vi.fn(), render = vi.fn(), close = vi.fn();
  const sourceBlob = new Blob(["source"], { type: "image/jpeg" });
  const canvas = { width: 1920, height: 1080, isConnected: true, toBlob: (cb: (blob: Blob) => void) => cb(sourceBlob) };
  const querySelector = vi.fn(() => canvas);
  const author = { ...canvas, parentElement: { querySelector } };
  let backend = "webgpu";
  const engine = { renderer: { domElement: author, render }, getRendererBackend: () => backend,
    subscribePresentationFrames: (callback: () => void) => { frame = callback; return dispose; } } as unknown as ViewerEngine;
  const bitmap = { width: 1920, height: 1080, close };
  const createBitmap = vi.fn(async () => bitmap);
  vi.stubGlobal("createImageBitmap", createBitmap);
  const drawImage = vi.fn();
  vi.stubGlobal("document", { createElement: () => ({ width: 0, height: 0,
    getContext: () => ({ drawImage }), toBlob: (cb: (blob: Blob) => void) => cb(new Blob(["jpeg"])) }) });
  vi.stubGlobal("FileReader", class { result = "data:image/jpeg;base64,fixture"; onload?: () => void;
    readAsDataURL() { this.onload?.(); } });
  return { engine, canvas, sourceBlob, author, createBitmap, close, dispose, render, drawImage,
    frame: () => frame?.(), switchBackend: () => { backend = "webgl"; } };
}
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
describe("asynchronous thumbnail presentation ownership", () => {
  it("captures the actual Deep canvas after a presented frame without hidden Three rendering", async () => {
    const f = fixture(), capture = captureSceneThumbnailAsync(f.engine);
    expect(f.createBitmap).not.toHaveBeenCalled(); f.frame();
    expect(await capture).toBe("data:image/jpeg;base64,fixture");
    expect(f.createBitmap).toHaveBeenCalledWith(f.sourceBlob);
    expect(f.render).not.toHaveBeenCalled(); expect(f.close).toHaveBeenCalledOnce(); expect(f.dispose).toHaveBeenCalledOnce();
  });
  it("abandons a backend changed before the frame", async () => {
    const f = fixture(), capture = captureSceneThumbnailAsync(f.engine);
    f.switchBackend(); f.frame(); expect(await capture).toBeUndefined(); expect(f.createBitmap).not.toHaveBeenCalled();
  });
  it("closes a bitmap delivered after timeout or canvas disposal", async () => {
    vi.useFakeTimers(); const f = fixture();
    let finish!: (bitmap: { width: number; height: number; close: typeof f.close }) => void;
    f.createBitmap.mockReturnValue(new Promise(resolve => { finish = resolve; }));
    const capture = captureSceneThumbnailAsync(f.engine); f.frame();
    await vi.advanceTimersByTimeAsync(1500); expect(await capture).toBeUndefined();
    finish({ width: 1920, height: 1080, close: f.close }); await Promise.resolve();
    expect(f.close).toHaveBeenCalledOnce(); expect(f.drawImage).not.toHaveBeenCalled(); expect(f.dispose).toHaveBeenCalledOnce();
  });
  it("returns without blocking saving if no presentation frame arrives", async () => {
    vi.useFakeTimers(); const f = fixture(), capture = captureSceneThumbnailAsync(f.engine);
    await vi.advanceTimersByTimeAsync(1500); expect(await capture).toBeUndefined(); expect(f.dispose).toHaveBeenCalledOnce();
  });
});
