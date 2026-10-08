import type { RenderPacket } from "@bim-studio/deep-engine";
import type { RenderView } from "@bim-studio/deep-engine/webgpu";

interface Target {
  prepareRenderPacket(packet: RenderPacket, view: RenderView, signal?: AbortSignal): Promise<unknown>;
}

/** One author compile/upload at a time; unchanged compiled packets never reupload. */
export class StudioDeepAuthorPacketSync {
  private packets = new WeakMap<Target, RenderPacket>();
  private pending: AbortController | undefined;
  private pendingWork: Promise<RenderPacket | undefined> | undefined;

  seed(target: Target, packet: RenderPacket): void { this.packets.set(target, packet); }
  current(target: Target): RenderPacket | undefined { return this.packets.get(target); }
  cancel(): void { this.pending?.abort(); this.pending = undefined; }
  dispose(): void { this.cancel(); this.packets = new WeakMap(); }
  async whenIdle(): Promise<void> { await this.pendingWork?.catch(() => undefined); }

  async refresh(target: Target, provider: (signal: AbortSignal) => Promise<RenderPacket | undefined>,
    readView: () => RenderView, prepareCandidate?: (packet: RenderPacket) => RenderPacket): Promise<RenderPacket | undefined> {
    const work = this.refreshTransaction(target, provider, readView, prepareCandidate); this.pendingWork = work;
    try { return await work; } finally { if (this.pendingWork === work) this.pendingWork = undefined; }
  }
  private async refreshTransaction(target: Target, provider: (signal: AbortSignal) => Promise<RenderPacket | undefined>,
    readView: () => RenderView, prepareCandidate?: (packet: RenderPacket) => RenderPacket): Promise<RenderPacket | undefined> {
    this.cancel();
    const controller = new AbortController(); this.pending = controller;
    try {
      const packet = await provider(controller.signal);
      controller.signal.throwIfAborted();
      if (!packet) throw new Error("作者外观已超出当前独立包能力，请切换引擎后重试。");
      if (this.packets.get(target) === packet) return undefined;
      const candidate = prepareCandidate?.(packet) ?? packet;
      await target.prepareRenderPacket(candidate, readView(), controller.signal);
      controller.signal.throwIfAborted();
      this.packets.set(target, packet);
      return candidate;
    } finally { if (this.pending === controller) this.pending = undefined; }
  }
}
