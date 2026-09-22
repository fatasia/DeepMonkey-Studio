import { describe, expect, it, vi } from "vitest";
import type { RenderPacket } from "../renderPacket.js";
import type { PbrRenderer } from "../webgpu/pbrRenderer.js";
import { DeepApp } from "./deepApp.js";
import { PBR_RENDERER_FRAME_STATE, PBR_RENDERER_RESOURCE, PbrRendererPlugin } from "./pbrRendererPlugin.js";

const packet: RenderPacket = { geometries: [], materials: [], instances: [] };
const view = { eye: [0, 0, 5], target: [0, 0, 0], extent: 5, background: [0.02, 0.03, 0.05],
  floor: [0.1, 0.1, 0.1], exposure: 1, roughness: 0.5, width: 640, height: 360, pixelRatio: 1 } as const;

describe("PbrRendererPlugin", () => {
  it("publishes the production renderer, renders from host frames, and aborts before disposal", async () => {
    const events: string[] = [], setPacket = vi.fn(), render = vi.fn(() => undefined), dispose = vi.fn(() => events.push("dispose"));
    let signal: AbortSignal | undefined;
    const renderer = { setPacket, render, dispose } as unknown as PbrRenderer;
    const createRenderer = vi.fn(async (_canvas, _gpu, candidate: AbortSignal) => { signal = candidate; return renderer; });
    const plugin = new PbrRendererPlugin({ canvas: {} as HTMLCanvasElement, packet,
      view: context => { expect(context.state.label).toBe("external"); return view; },
      createRenderer });
    const app = await DeepApp.create({ state: { label: "external" }, plugins: [plugin] });
    expect(app.requireResource(PBR_RENDERER_RESOURCE)).toBe(renderer);
    expect(setPacket).toHaveBeenCalledWith(packet); expect(signal?.aborted).toBe(false);
    expect(await app.advance(12)).toMatchObject({ status: "rendered" });
    expect(render).toHaveBeenCalledWith(view);
    expect(app.requireResource(PBR_RENDERER_FRAME_STATE).current).toBeUndefined();
    await app.dispose();
    expect(signal?.aborted).toBe(true); expect(dispose).toHaveBeenCalledOnce();
  });

  it("relays external cancellation while renderer creation is pending", async () => {
    const external = new AbortController(); let received: AbortSignal | undefined;
    const plugin = new PbrRendererPlugin({ canvas: {} as HTMLCanvasElement, signal: external.signal, view: () => view,
      createRenderer: async (_canvas, _gpu, signal) => {
        received = signal; external.abort("cancel fixture");
        await Promise.resolve(); throw new DOMException("cancelled", "AbortError");
      } });
    await expect(DeepApp.create({ state: null, plugins: [plugin] })).rejects.toThrow(/initialization failed/);
    expect(received?.aborted).toBe(true); expect(received?.reason).toBe("cancel fixture");
  });
});

