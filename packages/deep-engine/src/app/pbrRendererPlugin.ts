import type { FrameMetrics, PbrRendererOptions, RenderView } from "../webgpu/pbrRendererTypes.js";
import { PbrRenderer } from "../webgpu/pbrRenderer.js";
import type { RenderPacket } from "../renderPacket.js";
import { createDeepAppResource, type DeepAppAccess, type DeepAppPlugin } from "./appTypes.js";

export const PBR_RENDERER_RESOURCE = createDeepAppResource<PbrRenderer>("deep.pbr-renderer");

export interface PbrRendererFrameState {
  current: FrameMetrics | undefined;
}
export const PBR_RENDERER_FRAME_STATE = createDeepAppResource<PbrRendererFrameState>("deep.pbr-renderer.frame-state");

export interface PbrRendererViewContext<TState> {
  readonly state: TState;
  readonly app: DeepAppAccess<TState>;
  readonly frameIndex: number;
  readonly timeMs: number;
  readonly deltaMs: number;
}

export type PbrRendererFactory = (canvas: HTMLCanvasElement, gpu: GPU | undefined,
  signal: AbortSignal, options: PbrRendererOptions) => Promise<PbrRenderer>;

export interface PbrRendererPluginOptions<TState> {
  readonly canvas: HTMLCanvasElement;
  readonly gpu?: GPU;
  readonly signal?: AbortSignal;
  readonly renderer?: PbrRendererOptions;
  readonly packet?: RenderPacket | ((state: TState, app: DeepAppAccess<TState>) => RenderPacket);
  readonly view: (context: PbrRendererViewContext<TState>) => RenderView;
  readonly id?: string;
  readonly dependencies?: readonly string[];
  readonly createRenderer?: PbrRendererFactory;
}

/** Installs the production WebGPU renderer into a host-driven DeepApp frame. */
export class PbrRendererPlugin<TState> implements DeepAppPlugin<TState> {
  readonly id: string;
  readonly dependencies: readonly string[];

  constructor(private readonly options: PbrRendererPluginOptions<TState>) {
    this.id = options.id ?? "deep.pbr-renderer";
    this.dependencies = Object.freeze([...(options.dependencies ?? [])]);
  }

  async setup(context: Parameters<DeepAppPlugin<TState>["setup"]>[0]): Promise<void> {
    const controller = new AbortController();
    context.onDispose(() => controller.abort("Deep application disposed."));
    const detach = relayAbort(this.options.signal, controller);
    if (detach) context.onDispose(detach);
    const create = this.options.createRenderer ?? PbrRenderer.create;
    const renderer = await create(this.options.canvas, this.options.gpu, controller.signal, this.options.renderer ?? {});
    context.onDispose(() => renderer.dispose());
    const packet = typeof this.options.packet === "function"
      ? this.options.packet(context.state, context) : this.options.packet;
    if (packet) renderer.setPacket(packet);
    const frameState: PbrRendererFrameState = { current: undefined };
    context.provide(PBR_RENDERER_RESOURCE, renderer);
    context.provide(PBR_RENDERER_FRAME_STATE, frameState);
    context.addFrameStage({ id: `${this.id}:render`, priority: 1000, execute: frame => {
      frameState.current = renderer.render(this.options.view({ state: frame.context.state, app: frame.context,
        frameIndex: frame.frameIndex, timeMs: frame.timeMs, deltaMs: frame.deltaMs }));
    } });
    context.invalidate(`${this.id}:ready`);
  }
}

function relayAbort(source: AbortSignal | undefined, target: AbortController): (() => void) | undefined {
  if (!source) return undefined;
  if (source.aborted) { target.abort(source.reason); return undefined; }
  const abort = () => target.abort(source.reason);
  source.addEventListener("abort", abort, { once: true });
  return () => source.removeEventListener("abort", abort);
}

