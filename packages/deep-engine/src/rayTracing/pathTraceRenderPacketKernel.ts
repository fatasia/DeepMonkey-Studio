import type { RenderPacket } from "../renderPacketTypes.js";
import { validateRuntimeSceneCamera, type RuntimeSceneCamera } from "../runtimePackage/camera.js";
import type { PathTraceReferenceKernel } from "./pathTraceReferenceKernel.js";
import { createPathTraceCpuTransport, type PathTraceCpuTransportOptions } from "./pathTraceCpuTransport.js";
import { buildPathTraceRenderPacketScene } from "./pathTraceRenderPacketScene.js";
import { PATH_TRACE_RENDER_PACKET_PROFILE } from "./pathTraceRenderPacketMaterial.js";
import type { RuntimeCoordinateFrame } from "../runtimePackage/coordinates.js";

export interface PathTraceRenderPacketKernelOptions extends Omit<PathTraceCpuTransportOptions, "camera" | "cameraDepthRange"> {
  readonly packet: RenderPacket;
  readonly camera: RuntimeSceneCamera;
}
export interface PathTraceRenderPacketKernel extends PathTraceReferenceKernel {
  readonly profile: typeof PATH_TRACE_RENDER_PACKET_PROFILE;
  readonly instanceCount: number;
  readonly uniqueBlasCount: number;
  /** Packet and camera coordinates remain in this validated scene-local frame. */
  readonly coordinateFrame?: RuntimeCoordinateFrame;
}

/** Formal static scene adapter; unsupported scene features fail closed before image export. */
export function createPathTraceRenderPacketKernel(options: PathTraceRenderPacketKernelOptions): PathTraceRenderPacketKernel {
  const camera = validateRuntimeSceneCamera(options.camera);
  if (options.lighting?.shadows && options.packet.instances.some(instance =>
    instance.castShadow === false || instance.receiveShadow === false)) {
    throw new Error("CPU path trace unsupported instance castShadow/receiveShadow override with directional shadows.");
  }
  if (camera.clippingPlane !== undefined) {
    throw new Error("CPU path trace unsupported camera section clipping.");
  }
  const scene = buildPathTraceRenderPacketScene(options.packet);
  const kernel = createPathTraceCpuTransport({ ...options,
    camera: { origin: camera.position, target: camera.target, up: [0, 1, 0], verticalFovDegrees: camera.verticalFovDegrees },
    cameraDepthRange: [camera.near, camera.far] }, scene.traceSurface);
  return Object.freeze({ traceSample: kernel.traceSample, profile: PATH_TRACE_RENDER_PACKET_PROFILE,
    instanceCount: scene.instanceCount, uniqueBlasCount: scene.uniqueBlasCount,
    ...(camera.coordinateFrame ? { coordinateFrame: Object.freeze({ ...camera.coordinateFrame,
      origin: Object.freeze({ ...camera.coordinateFrame.origin }), profile: Object.freeze({ ...camera.coordinateFrame.profile }) }) } : {}) });
}
