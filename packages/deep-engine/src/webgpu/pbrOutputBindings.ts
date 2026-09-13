import type { Pipelines } from "./pipelines.js";

/** Caches immutable output bindings without exposing renderer-owned GPU handles. */
export class PbrOutputBindings {
  private readonly textureViews = new WeakMap<GPUTexture, GPUTextureView>();
  private readonly bindings = new WeakMap<GPUTexture, GPUBindGroup>();
  private readonly sampler: GPUSampler;

  constructor(private readonly device: GPUDevice, private readonly pipelines: Pipelines,
    private readonly outputBuffer: GPUBuffer) {
    this.sampler = device.createSampler({ minFilter: "linear", magFilter: "linear" });
  }

  view(texture: GPUTexture): GPUTextureView {
    let view = this.textureViews.get(texture);
    if (!view) { view = texture.createView(); this.textureViews.set(texture, view); }
    return view;
  }

  binding(texture: GPUTexture): GPUBindGroup {
    let binding = this.bindings.get(texture);
    if (!binding) {
      binding = this.device.createBindGroup({ layout: this.pipelines.output.getBindGroupLayout(0), entries: [
        { binding: 0, resource: this.view(texture) }, { binding: 1, resource: this.sampler },
        { binding: 2, resource: { buffer: this.outputBuffer } },
      ] });
      this.bindings.set(texture, binding);
    }
    return binding;
  }
}
