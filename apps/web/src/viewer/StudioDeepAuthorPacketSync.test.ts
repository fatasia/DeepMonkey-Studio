import { describe, expect, it, vi } from "vitest";
import type { RenderPacket } from "@bim-studio/deep-engine";
import type { RenderView } from "@bim-studio/deep-engine/webgpu";
import { StudioDeepAuthorPacketSync } from "./StudioDeepAuthorPacketSync";

const packet = (): RenderPacket => ({ geometries: [], materials: [], instances: [] });
const view = {} as RenderView;

describe("independent author packet revision sync", () => {
  it("prepares an owned pose candidate after raw compiler identity deduplication", async () => {
    const sync = new StudioDeepAuthorPacketSync(), raw = packet(), candidate = packet();
    const target = { prepareRenderPacket: vi.fn().mockResolvedValue(undefined) }, prepare = vi.fn(() => candidate);
    expect(await sync.refresh(target, async () => raw, () => view, prepare)).toBe(candidate);
    expect(target.prepareRenderPacket).toHaveBeenCalledWith(candidate, view, expect.any(AbortSignal));
    expect(sync.current(target)).toBe(raw);
    expect(await sync.refresh(target, async () => raw, () => view, prepare)).toBeUndefined();
    expect(prepare).toHaveBeenCalledOnce();
  });
  it("reuses unchanged compiler output and uploads changed author state using the latest view", async () => {
    const sync = new StudioDeepAuthorPacketSync(), initial = packet(), changed = packet();
    const target = { prepareRenderPacket: vi.fn().mockResolvedValue(undefined) };
    sync.seed(target, initial);
    expect(await sync.refresh(target, async () => initial, () => view)).toBeUndefined();
    expect(target.prepareRenderPacket).not.toHaveBeenCalled();
    const latest = { ...view, exposure: 2 };
    expect(await sync.refresh(target, async () => changed, () => latest)).toBe(changed);
    expect(target.prepareRenderPacket).toHaveBeenCalledWith(changed, latest, expect.any(AbortSignal));
    await sync.refresh(target, async () => changed, () => view);
    expect(target.prepareRenderPacket).toHaveBeenCalledOnce();
  });

  it("cancels outdated compiles before upload and keeps a new backend isolated", async () => {
    const sync = new StudioDeepAuthorPacketSync(), target = { prepareRenderPacket: vi.fn() };
    let resolve!: (value: RenderPacket) => void;
    const pending = sync.refresh(target, () => new Promise<RenderPacket>(yes => { resolve = yes; }), () => view);
    const cancelled = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    sync.dispose(); resolve(packet()); await cancelled;
    expect(target.prepareRenderPacket).not.toHaveBeenCalled();
    const next = packet(); target.prepareRenderPacket.mockResolvedValue(undefined);
    expect(await sync.refresh(target, async () => next, () => view)).toBe(next);
  });

  it("does not acknowledge failed uploads or unsupported new appearance", async () => {
    const sync = new StudioDeepAuthorPacketSync(), next = packet();
    const target = { prepareRenderPacket: vi.fn().mockRejectedValueOnce(new Error("upload failed")).mockResolvedValue(undefined) };
    await expect(sync.refresh(target, async () => next, () => view)).rejects.toThrow("upload failed");
    expect(await sync.refresh(target, async () => next, () => view)).toBe(next);
    expect(target.prepareRenderPacket).toHaveBeenCalledTimes(2);
    await expect(sync.refresh(target, async () => undefined, () => view)).rejects.toThrow("作者外观");
  });
});
