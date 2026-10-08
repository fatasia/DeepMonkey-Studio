import type { PbrRenderer, PbrRendererOptions } from "@bim-studio/deep-engine/webgpu";

type Factory = Pick<typeof PbrRenderer, "create">;
/** Owns a speculative runtime until the backend factory takes it, or cancellation releases it. */
export class StudioDeepRuntimePreparation {
  private taken = false;
  private closed = false;
  private readonly task: ReturnType<Factory["create"]>;
  private readonly abort = () => this.dispose();
  constructor(private readonly factory: Factory, canvas: Parameters<Factory["create"]>[0],
    gpu: GPU, private readonly signal: AbortSignal, private readonly options: PbrRendererOptions) {
    this.task = factory.create(canvas, gpu, signal, options);
    void this.task.catch(() => undefined);
    signal.addEventListener("abort", this.abort, { once: true });
    if (signal.aborted) this.dispose();
  }
  readonly create: Factory["create"] = async (canvas, gpu, signal, options = {}) => {
    // Pipeline hints may differ; packet preparation admits every actually-used variant.
    const compatible = !!options.advancedMaterials === !!this.options.advancedMaterials
      && options.msaaSampleCount === this.options.msaaSampleCount
      && JSON.stringify(options.shadows) === JSON.stringify(this.options.shadows);
    if (!compatible || this.closed || this.taken) {
      this.dispose();
      return this.factory.create(canvas, gpu, signal, options);
    }
    const runtime = await this.task;
    signal?.throwIfAborted();
    if (this.closed) throw new DOMException("Runtime preparation cancelled.", "AbortError");
    this.taken = true;
    this.signal.removeEventListener("abort", this.abort);
    return runtime;
  };
  dispose(): void {
    if (this.closed || this.taken) return;
    this.closed = true;
    this.signal.removeEventListener("abort", this.abort);
    void this.task.then(runtime => runtime.dispose(), () => undefined);
  }
}
