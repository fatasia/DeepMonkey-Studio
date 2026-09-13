/// <reference types="@webgpu/types" />
import type { DeviceSession } from "../webgpu/deviceSession.js";
import { FORWARD_PLUS_LIGHTING_BIND_GROUP } from "./clusterAbiWgsl.js";
import type { ForwardPlusClusterResources } from "./clusterCompute.js";

type LightingSession = Pick<DeviceSession, "device" | "state">;

export interface ForwardPlusPbrBindingResult {
  readonly group: typeof FORWARD_PLUS_LIGHTING_BIND_GROUP;
  readonly bindGroup: GPUBindGroup;
  readonly layout: GPUBindGroupLayout;
}

/** Caches group-3 bindings until the assigner changes an underlying buffer capacity. */
export class ForwardPlusPbrLightingBindings {
  readonly layout: GPUBindGroupLayout;
  private signature: readonly GPUBuffer[] | undefined;
  private cached: GPUBindGroup | undefined;
  private disposed = false;

  constructor(private readonly session: LightingSession) {
    this.assertReady();
    this.layout = session.device.createBindGroupLayout({ label: "Deep Forward+ PBR lighting group 3", entries: [0, 1, 2, 3, 4, 5].map(binding => ({
      binding, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "read-only-storage" as const },
    })) });
  }

  bind(resources: ForwardPlusClusterResources): ForwardPlusPbrBindingResult {
    this.assertReady();
    const signature = [resources.clusterParameterBuffer, resources.directionalLightBuffer, resources.pointLightBuffer,
      resources.spotLightBuffer, resources.clusterHeaderBuffer, resources.clusterLightIndexBuffer] as const;
    if (!this.cached || !this.signature || !signature.every((buffer, index) => buffer === this.signature![index])) {
      const bindGroup = this.session.device.createBindGroup({ label: "Deep Forward+ PBR lighting bindings", layout: this.layout,
        entries: signature.map((buffer, binding) => ({ binding, resource: { buffer } })) });
      this.signature = signature; this.cached = bindGroup;
    }
    return { group: FORWARD_PLUS_LIGHTING_BIND_GROUP, bindGroup: this.cached, layout: this.layout };
  }

  dispose(): void { this.disposed = true; this.signature = undefined; this.cached = undefined; }

  private assertReady(): void {
    if (this.disposed) throw new Error("Forward+ PBR lighting bindings are disposed.");
    if (this.session.state !== "ready") throw new Error(`Forward+ PBR lighting cannot use a ${this.session.state} GPU session.`);
  }
}
