import { getActiveLeg } from "./virtualShadowProbeSession.js";
import { dumpShadowAtlasLayer } from "./virtualShadowProbeDiag.js";

// B1 Brief-VSM probe M2 诊断:虚拟解析逐 mip 重放(sourceSizeGate 拆分:自
// virtualShadowGpuProbe.ts 按职责分文件,代码逐行同源,仅改可见性;语义零变化)。
// 职责:世界点集 → GPU 读回数据上逐 mip 重放 deepVsmResolveRing(定位全亮缺陷环节)。
// 带采样策略对分(diagVirtualBand)在 virtualShadowProbeBandDiag.ts。

/** M2 诊断:世界点集 → GPU 读回数据上逐 mip 重放 deepVsmResolveRing(定位全亮缺陷环节)。 */
export interface VirtualResolveSample {
  readonly label: string;
  readonly world: readonly [number, number, number];
}

/** 列主序 mat4 · vec3(w=1),与 projectToRing/deepVsmResolveRing 同合同。 */
function multiplyMatrixPoint(m: Float32Array, p: readonly [number, number, number]): {
  readonly x: number; readonly y: number; readonly z: number; readonly w: number } {
  const [x, y, z] = p;
  return {
    x: m[0]! * x + m[4]! * y + m[8]! * z + m[12]!,
    y: m[1]! * x + m[5]! * y + m[9]! * z + m[13]!,
    z: m[2]! * x + m[6]! * y + m[10]! * z + m[14]!,
    w: m[3]! * x + m[7]! * y + m[11]! * z + m[15]!,
  };
}

export async function diagVirtualResolve(samples: readonly VirtualResolveSample[]): Promise<unknown> {
  const active = getActiveLeg();
  if (!active) throw new Error("beginLeg was not called.");
  const resources = (active.renderer as unknown as {
    virtualShadows?: { atlas: GPUTexture; uniformBuffer: GPUBuffer; metaBuffer: GPUBuffer;
      layersBuffer: GPUBuffer };
  }).virtualShadows;
  if (!resources) throw new Error("virtual shadow resources unavailable.");
  const device = active.renderer.session.device;
  const readback = async (buffer: GPUBuffer, size: number): Promise<ArrayBuffer> => {
    const staging = device.createBuffer({ size, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const encoder = device.createCommandEncoder({ label: "vsm diag readback" });
    encoder.copyBufferToBuffer(buffer, 0, staging, 0, size);
    device.queue.submit([encoder.finish()]);
    await staging.mapAsync(GPUMapMode.READ);
    const copy = staging.getMappedRange().slice(0);
    staging.unmap();
    staging.destroy();
    return copy;
  };
  const uniform = new Float32Array(await readback(resources.uniformBuffer, resources.uniformBuffer.size));
  const meta = new Uint32Array(await readback(resources.metaBuffer, resources.metaBuffer.size));
  const layers = new Int32Array(await readback(resources.layersBuffer, resources.layersBuffer.size));
  const atlasLayers = [0, 1, 2, 3].map(layer => dumpShadowAtlasLayer(layer));
  const atlas = await Promise.all(atlasLayers);
  const bias = uniform[149]!;
  const rows = samples.map(sample => {
    const perRing = [0, 1, 2].map(ring => {
      const matrix = uniform.slice(ring * 16, ring * 16 + 16);
      const clip = multiplyMatrixPoint(matrix, sample.world);
      if (!(clip.w > 0)) return { ring, error: "clip.w<=0" };
      const ndc = { x: clip.x / clip.w, y: clip.y / clip.w, z: clip.z / clip.w };
      const uv = { x: ndc.x * 0.5 + 0.5, y: ndc.y * -0.5 + 0.5 };
      const receiverDepth = ndc.z;
      const perMip = [0, 1, 2, 3, 4, 5, 6, 7].map(mip => {
        const grid = 128 >> mip;
        const tileU = uv.x * grid, tileV = uv.y * grid;
        const tx = Math.floor(tileU), ty = Math.floor(tileV);
        if (tx < 0 || ty < 0 || tx >= grid || ty >= grid) return { mip, miss: "outside" };
        const row = (ring * 8 + mip) * 4;
        const gridW = meta[row]!, layersBase = meta[row + 2]!;
        const slot = layers[layersBase + ty * gridW + tx]!;
        if (slot < 0) return { mip, miss: "no-page" };
        const pageTexelU = (tileU - tx) * 128, pageTexelV = (tileV - ty) * 128;
        const localU = Math.min(127.5, Math.max(0.5, pageTexelU)), localV = Math.min(127.5, Math.max(0.5, pageTexelV));
        const atlasTileX = slot % 16, atlasTileY = Math.floor(slot / 16) % 16, atlasLayer = Math.floor(slot / 256);
        const floats = atlas[atlasLayer]!.floats;
        const at = (du: number, dv: number): number =>
          floats[Math.min(2047, atlasTileY * 128 + Math.floor(localV) + dv) * 2048
            + Math.min(2047, atlasTileX * 128 + Math.floor(localU) + du)]!;
        const center = at(0, 0);
        let lit = 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          if (at(dx, dy) >= receiverDepth - bias) lit += 1;
        }
        return { mip, slot, pageTexel: [pageTexelU, pageTexelV].map(v => Math.round(v * 10) / 10),
          depth: center, shadowed: center < receiverDepth - bias, pcf9Lit: `${lit}/9` };
      });
      return { ring, uv: [uv.x, uv.y].map(v => Math.round(v * 5) / 10000), receiverDepth,
        texelWorld: uniform[144 + ring], mips: perMip };
    });
    return { label: sample.label, world: sample.world, rings: perRing };
  });
  return { bias, texelWorld0: Array.from(uniform.slice(144, 148)),
    params2: Array.from(uniform.slice(156, 160)), rows };
}
