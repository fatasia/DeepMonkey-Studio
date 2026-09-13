import type { PbrRenderer, RenderView } from "@bim-studio/deep-engine/webgpu";
import { mixedPacket } from "./scenePacket.js";

/** 实验页故障注入：不申请大量显存，用非法 usage 触发真实 GPUValidationError。 */
export async function verifyPacketRollback(renderer: PbrRenderer, view: RenderView) {
  renderer.render(view);
  const before = await renderer.validateFrame(view), device = renderer.session.device;
  const candidate = mixedPacket(9), suffix = "/failure-check";
  const packet = { ...candidate, geometries: candidate.geometries.map(geometry => ({ ...geometry, id: geometry.id + suffix })),
    instances: candidate.instances.map(instance => ({ ...instance, geometry: instance.geometry + suffix })) };
  const createBuffer = device.createBuffer;
  let injected = false, pending: Promise<void>;
  device.createBuffer = function (descriptor: GPUBufferDescriptor): GPUBuffer {
    if (injected) return createBuffer.call(device, descriptor);
    injected = true;
    return createBuffer.call(device, { ...descriptor, size: 4, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.VERTEX });
  };
  try { pending = renderer.setPacketValidated(packet); }
  finally { device.createBuffer = createBuffer; }
  let expectedError = "";
  try { await pending; } catch (error) { expectedError = error instanceof Error ? error.message : String(error); }
  if (!injected || !expectedError.startsWith("GPU packet preparation failed:")) throw new Error("GPU validation fault was not caught by the packet transaction.");
  const after = await renderer.validateFrame(view);
  if (after.resources !== before.resources || after.triangles !== before.triangles || after.drawCalls !== before.drawCalls) {
    throw new Error("Failed packet changed the active projection or leaked resources.");
  }
  return { action: "packet-rollback", expectedError, before, after, deviceErrors: renderer.session.diagnostics };
}
