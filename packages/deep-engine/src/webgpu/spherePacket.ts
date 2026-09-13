import type { RenderPacket } from "../renderPacket.js";
import { validateInstances } from "./meshBuffers.js";
import { sphereMesh } from "./primitives.js";

/** 旧材质球夹具的过渡适配；渲染器内部统一使用通用投影。 */
export function spherePacket(data: Float32Array<ArrayBuffer>): RenderPacket {
  const count = validateInstances(data);
  return {
    geometries: [{ id: "deep-sphere", revision: 0, ...sphereMesh() }],
    materials: Array.from({ length: count }, (_, i) => ({ id: String(i), baseColor: [data[i * 12 + 4]!, data[i * 12 + 5]!, data[i * 12 + 6]!] as const, metallic: data[i * 12 + 7]!, roughness: data[i * 12 + 8]! })),
    instances: Array.from({ length: count }, (_, i) => {
      const n = i * 12, r = data[n + 3]!;
      return { id: String(i), geometry: "deep-sphere", material: String(i), transform: [r, 0, 0, 0, 0, r, 0, 0, 0, 0, r, 0, data[n]!, data[n + 1]!, data[n + 2]!, 1] };
    }),
  };
}
