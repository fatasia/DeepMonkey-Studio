import type { InstanceUpdate, RenderPacket } from "@bim-studio/deep-engine/webgpu";

/** 宿主驱动实例动画，几何和材质保持共享；不调用完整模型载入路径。 */
export function instanceMotionUpdate(packet: RenderPacket, time: number): InstanceUpdate {
  const c = Math.cos(time * 0.35), s = Math.sin(time * 0.35);
  return { materials: packet.materials, instances: packet.instances.map((instance, i) => {
    const original = instance.transform, m = Array.from(original);
    for (let column = 0; column < 3; column++) {
      m[column * 4] = c * original[column * 4]! + s * original[column * 4 + 2]!;
      m[column * 4 + 2] = -s * original[column * 4]! + c * original[column * 4 + 2]!;
    }
    m[13]! += 0.35 * (1 + Math.sin(time * 1.6 + i * 0.4));
    return { ...instance, transform: m };
  }) };
}
