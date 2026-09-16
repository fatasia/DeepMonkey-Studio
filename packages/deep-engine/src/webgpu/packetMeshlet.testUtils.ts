import { vi } from "vitest";
import { authorFixture, authorPacket } from "./authorLod.testUtils.js";
import { PacketBuffers } from "./packetBuffers.js";
export function meshletPacket() {
  const packet = authorPacket([0]);
  const vertices = new Float32Array(1344 * 18), indices = new Uint32Array(1344 * 3);
  for (let triangle = 0; triangle < 1344; triangle++) {
    const x = triangle < 672 ? -.5 : .5;
    vertices.set([x - .1, -.1, 0, 0, 0, 1, x + .1, -.1, 0, 0, 0, 1, x, .1, 0, 0, 0, 1], triangle * 18);
    indices.set([triangle * 3, triangle * 3 + 1, triangle * 3 + 2], triangle * 3);
  }
  return { ...packet, geometries: [{ id: "high", revision: 1, vertices, indices }, packet.geometries[1]!] };
}
export function meshletFixture() {
  const f = authorFixture();
  Object.assign(f.device.limits, { maxUniformBufferBindingSize: 65536, maxTextureDimension2D: 8192,
    maxComputeInvocationsPerWorkgroup: 256, maxComputeWorkgroupSizeX: 256, maxBindingsPerBindGroup: 1000,
    maxStorageBuffersPerShaderStage: 8, maxUniformBuffersPerShaderStage: 12, maxSampledTexturesPerShaderStage: 16 });
  Object.assign(f.device, { createTexture: vi.fn(() => ({ createView: () => ({}), destroy: vi.fn() })) });
  return { ...f, cache: new PacketBuffers(f.session, undefined, undefined, true) };
}
