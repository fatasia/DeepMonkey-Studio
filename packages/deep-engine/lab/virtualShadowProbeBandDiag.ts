import { PROBE_WIDTH, PROBE_HEIGHT, VIEW } from "./virtualShadowProbeScene.js";
import { getActiveLeg } from "./virtualShadowProbeSession.js";
import { dumpShadowAtlasLayer } from "./virtualShadowProbeDiag.js";

// B1 Brief-VSM probe M2 诊断:阴影带地面像素逐点策略对分(sourceSizeGate 拆分:自
// virtualShadowGpuProbe.ts 按职责分文件,代码逐行同源,仅改可见性;语义零变化)。
// 职责:VirtualBandSample/VirtualBandReport 合同、diagViewProjection 相机矩阵镜像、
// diagVirtualBand(旧链/就近/细优先/最细四种 mip 搜索策略同一次读回上评估)。

/** M2 策略实验:阴影带地面像素逐点重放 resolve(旧链/就近/细优先/最细),供 Node 侧对分。 */
export interface VirtualBandSample {
  /** 阴影带内像素索引((py−y0)·bandWidth + (px−x0))。 */
  readonly bandIndex: number;
  readonly desired: number;
  readonly worldZ: number;
  /** 各策略 9-tap PCF 可见度(0..1,-1 = 全环 miss)。 */
  readonly visibility: readonly { readonly policy: string; readonly visibility: number;
    readonly ring: number; readonly mip: number }[];
}

export interface VirtualBandReport {
  readonly bias: number;
  readonly samples: readonly VirtualBandSample[];
  readonly desiredHistogram: readonly { readonly desired: number; readonly count: number }[];
  readonly replayedPixels: number;
}

/** cameraMath.lookAt/perspective 镜像(列主序;仅诊断用,与 src 同式)。 */
function diagViewProjection(eye: readonly [number, number, number],
  target: readonly [number, number, number]): Float32Array {
  const aspect = PROBE_WIDTH / PROBE_HEIGHT;
  const f = 1 / Math.tan(Math.PI / 8);
  const perspective = new Float32Array([f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, 1 / (0.1 - 1000), -1, 0, 0, 0.1 * 1000 / (0.1 - 1000), 0]);
  const subtract = (a: number[], b: number[]): number[] => [a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!];
  const norm = (v: number[]): number[] => {
    const l = Math.hypot(...v);
    return [v[0]! / l, v[1]! / l, v[2]! / l];
  };
  const cross = (a: number[], b: number[]): number[] =>
    [a[1]! * b[2]! - a[2]! * b[1]!, a[2]! * b[0]! - a[0]! * b[2]!, a[0]! * b[1]! - a[1]! * b[0]!];
  const dot = (a: number[], b: number[]): number => a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
  const z = norm(subtract([...eye], [...target]));
  const x = norm(cross([0, 1, 0], z));
  const y = cross(z, x);
  const lookAt = new Float32Array([
    x[0]!, y[0]!, z[0]!, 0, x[1]!, y[1]!, z[1]!, 0, x[2]!, y[2]!, z[2]!, 0,
    -dot(x, [...eye]), -dot(y, [...eye]), -dot(z, [...eye]), 1,
  ]);
  const multiply = (a: Float32Array, b: Float32Array): Float32Array => {
    const out = new Float32Array(16);
    for (let column = 0; column < 4; column++) for (let row = 0; row < 4; row++) {
      for (let k = 0; k < 4; k++) out[column * 4 + row] = out[column * 4 + row]! + a[k * 4 + row]! * b[column * 4 + k]!;
    }
    return out;
  };
  return multiply(perspective, lookAt);
}

export async function diagVirtualBand(step = 6): Promise<VirtualBandReport> {
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
    const encoder = device.createCommandEncoder({ label: "vsm band diag readback" });
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
  const atlas = await Promise.all([0, 1, 2, 3].map(layer => dumpShadowAtlasLayer(layer)));
  const bias = uniform[149]!;
  const top = 7;
  const virtualEdge = 16384;
  const fetchDepth = (slot: number, pageTexelX: number, pageTexelY: number): number => {
    const localX = Math.min(127.5, Math.max(0.5, pageTexelX)), localY = Math.min(127.5, Math.max(0.5, pageTexelY));
    const tileX = slot % 16, tileY = Math.floor(slot / 16) % 16, layer = Math.floor(slot / 256);
    return atlas[layer]!.floats[(tileY * 128 + Math.floor(localY)) * 2048 + tileX * 128 + Math.floor(localX)]!;
  };
  /** deepVsmResolveMip 镜像。 */
  const resolveMip = (ring: number, mip: number, uvX: number, uvY: number, receiverNdcZ: number, texelWorld: number): {
    found: boolean; slot: number; pageTexelX: number; pageTexelY: number } => {
    const grid = 128 >> mip;
    const tileU = uvX * grid, tileV = uvY * grid;
    const tx = Math.floor(tileU), ty = Math.floor(tileV);
    if (tx < 0 || ty < 0 || tx >= grid || ty >= grid) return { found: false, slot: -1, pageTexelX: 0, pageTexelY: 0 };
    const row = (ring * 8 + mip) * 4;
    const slot = layers[meta[row + 2]! + ty * meta[row]! + tx]!;
    if (slot < 0) return { found: false, slot: -1, pageTexelX: 0, pageTexelY: 0 };
    return { found: true, slot, pageTexelX: (tileU - tx) * 128, pageTexelY: (tileV - ty) * 128 };
  };
  /** deepVsmFilter 镜像(pcssLightWorld=0:9-tap,半径 0.5 texel,phi=0 确定性)。 */
  const filter = (slot: number, px: number, py: number, texelWorld: number, receiverDepth: number): number => {
    const receiver = receiverDepth - bias;
    let visibility = fetchDepth(slot, px, py) >= receiver ? 1 : 0;
    for (let index = 0; index < 8; index++) {
      const angle = index * 0.7853981633974483;
      const offsetX = Math.cos(angle) * 0.5, offsetY = Math.sin(angle) * 0.5;
      visibility += fetchDepth(slot, px + offsetX, py + offsetY) >= receiver ? 1 : 0;
    }
    void texelWorld;
    return visibility / 9;
  };
  /** 策略族:同一次读回上评估四种 mip 搜索策略(环间回退同 deepVirtualShadow)。 */
  const policies = ["old", "nearest", "nearestFine", "finest"] as const;
  const resolveRing = (policy: typeof policies[number], ring: number, uvX: number, uvY: number,
    receiverNdcZ: number, desired: number, footprintWorld: number, ringTexel: number): {
    found: boolean; slot: number; px: number; py: number; texelWorld: number; mip: number } => {
    const candidates: { mip: number; texel: number }[] = [];
    if (policy === "old") {
      for (let mip = desired; mip <= top; mip++) candidates.push({ mip, texel: ringTexel * 2 ** mip });
    } else if (policy === "nearest") {
      for (let distance = 0; distance <= top; distance++) {
        const coarse = desired + distance;
        if (coarse <= top) candidates.push({ mip: coarse, texel: Math.max(ringTexel * 2 ** coarse, footprintWorld) });
        if (distance > 0 && desired - distance >= 0) {
          candidates.push({ mip: desired - distance, texel: Math.max(ringTexel * 2 ** (desired - distance), footprintWorld) });
        }
      }
    } else if (policy === "nearestFine") {
      for (let distance = 0; distance <= top; distance++) {
        if (distance > 0 && desired - distance >= 0) {
          candidates.push({ mip: desired - distance, texel: Math.max(ringTexel * 2 ** (desired - distance), footprintWorld) });
        }
        const coarse = desired + distance;
        if (coarse <= top) candidates.push({ mip: coarse, texel: Math.max(ringTexel * 2 ** coarse, footprintWorld) });
      }
    } else {
      for (let mip = 0; mip <= top; mip++) candidates.push({ mip, texel: Math.max(ringTexel * 2 ** mip, footprintWorld) });
    }
    for (const candidate of candidates) {
      const hit = resolveMip(ring, candidate.mip, uvX, uvY, receiverNdcZ, candidate.texel);
      if (hit.found) return { found: true, slot: hit.slot, px: hit.pageTexelX, py: hit.pageTexelY,
        texelWorld: candidate.texel, mip: candidate.mip };
    }
    return { found: false, slot: -1, px: 0, py: 0, texelWorld: 0, mip: -1 };
  };
  const viewProjection = diagViewProjection(VIEW.eye, VIEW.target);
  const projectMain = (world: readonly [number, number, number]): { x: number; y: number; w: number } => {
    const m = viewProjection;
    const cw = m[3]! * world[0] + m[7]! * world[1] + m[11]! * world[2] + m[15]!;
    const cx = m[0]! * world[0] + m[4]! * world[1] + m[8]! * world[2] + m[12]!;
    const cy = m[1]! * world[0] + m[5]! * world[1] + m[9]! * world[2] + m[13]!;
    return { x: cx / cw, y: cy / cw, w: cw };
  };
  /** 像素 → 地面 y=0 世界点(透视射线求交;相机在 y=1.7 俯视,恒相交)。 */
  const pixelGroundPoint = (sx: number, sy: number): [number, number, number] => {
    const aspect = PROBE_WIDTH / PROBE_HEIGHT;
    const ndcX = sx / PROBE_WIDTH * 2 - 1, ndcY = 1 - sy / PROBE_HEIGHT * 2;
    const tanHalf = Math.tan(Math.PI / 8);
    const viewDir = [ndcX * tanHalf * aspect, ndcY * tanHalf, -1];
    const subtract = (a: number[], b: number[]): number[] => [a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!];
    const zAxis = (() => {
      const backward = subtract([...VIEW.eye], [...VIEW.target]);
      const l = Math.hypot(...backward);
      return backward.map(v => v / l);
    })();
    const cross = (a: number[], b: number[]): number[] =>
      [a[1]! * b[2]! - a[2]! * b[1]!, a[2]! * b[0]! - a[0]! * b[2]!, a[0]! * b[1]! - a[1]! * b[0]!];
    const norm = (v: number[]): number[] => {
      const l = Math.hypot(...v);
      return [v[0]! / l, v[1]! / l, v[2]! / l];
    };
    const xAxis = norm(cross([0, 1, 0], zAxis));
    const yAxis = cross(zAxis, xAxis);
    const worldDir = [
      xAxis[0]! * viewDir[0]! + yAxis[0]! * viewDir[1]! + zAxis[0]! * viewDir[2]!,
      xAxis[1]! * viewDir[0]! + yAxis[1]! * viewDir[1]! + zAxis[1]! * viewDir[2]!,
      xAxis[2]! * viewDir[0]! + yAxis[2]! * viewDir[1]! + zAxis[2]! * viewDir[2]!,
    ];
    const t = -VIEW.eye[1]! / worldDir[1]!;
    return [VIEW.eye[0]! + worldDir[0]! * t, 0, VIEW.eye[2]! + worldDir[2]! * t];
  };
  const bandX0 = Math.floor(PROBE_WIDTH * 0.34), bandY0 = Math.floor(PROBE_HEIGHT * 0.52);
  const bandX1 = Math.floor(PROBE_WIDTH * 0.66), bandY1 = Math.floor(PROBE_HEIGHT * 0.97);
  const bandWidth = bandX1 - bandX0;
  const histogram = new Map<number, number>();
  const samples: VirtualBandSample[] = [];
  for (let sy = bandY0; sy < bandY1; sy += step) {
    for (let sx = bandX0; sx < bandX1; sx += step) {
      const world = pixelGroundPoint(sx, sy);
      const main = projectMain(world);
      if (!(main.w > 0)) continue;
      // 数值 fwidth(与 WGSL 同式:两轴差分绝对值求和,逐 ndc 分量)。
      const stepWorldX = pixelGroundPoint(sx + 1, sy);
      const stepWorldY = pixelGroundPoint(sx, sy + 1);
      const visibility: { policy: string; visibility: number; ring: number; mip: number }[] = [];
      const desiredByRing: number[] = [];
      // 每策略独立走环链(0→1→2),与 deepVirtualShadow 的环回退同式。
      const policyHits = new Map<string, { slot: number; px: number; py: number;
        texelWorld: number; receiverDepth: number; mip: number; ring: number }>();
      for (let ring = 0; ring < 3; ring++) {
        const matrix = uniform.slice(ring * 16, ring * 16 + 16);
        const project = (point: readonly [number, number, number]): { x: number; y: number; z: number } => {
          const cx = matrix[0]! * point[0] + matrix[4]! * point[1] + matrix[8]! * point[2] + matrix[12]!;
          const cy = matrix[1]! * point[0] + matrix[5]! * point[1] + matrix[9]! * point[2] + matrix[13]!;
          const cz = matrix[2]! * point[0] + matrix[6]! * point[1] + matrix[10]! * point[2] + matrix[14]!;
          return { x: cx, y: cy, z: cz }; // 正交 w=1。
        };
        const center = project(world);
        const gradX = project(stepWorldX), gradY = project(stepWorldY);
        const px = Math.abs(gradX.x - center.x) + Math.abs(gradY.x - center.x);
        const py = Math.abs(gradX.y - center.y) + Math.abs(gradY.y - center.y);
        const uvX = center.x * 0.5 + 0.5, uvY = center.y * -0.5 + 0.5;
        if (uvX < 0 || uvX > 1 || uvY < 0 || uvY > 1 || center.z < 0 || center.z > 1) continue;
        const receiverDepth = center.z;
        const ringTexel = uniform[144 + ring]!;
        const pixelsPerVirtualTexel = Math.max(Math.max(px, py), 0.000001) * virtualEdge;
        const mipLog = Math.log2(pixelsPerVirtualTexel);
        const desired = Math.min(top, Math.max(0, Math.floor(mipLog >= 0 ? mipLog + 0.5 : 0)));
        if (ring === 0) desiredByRing.push(desired);
        if (ring === 0) histogram.set(desired, (histogram.get(desired) ?? 0) + 1);
        const footprintWorld = ringTexel * 2 ** mipLog;
        for (const policy of policies) {
          if (policyHits.has(policy)) continue;
          const hit = resolveRing(policy, ring, uvX, uvY, receiverDepth, desired, footprintWorld, ringTexel);
          if (hit.found) policyHits.set(policy, { slot: hit.slot, px: hit.px, py: hit.py,
            texelWorld: hit.texelWorld, receiverDepth, mip: hit.mip, ring });
        }
      }
      for (const policy of policies) {
        const hit = policyHits.get(policy);
        visibility.push({ policy, visibility: hit ? filter(hit.slot, hit.px, hit.py, hit.texelWorld, hit.receiverDepth) : -1,
          ring: hit?.ring ?? -1, mip: hit?.mip ?? -1 });
      }
      samples.push({ bandIndex: (sy - bandY0) * bandWidth + (sx - bandX0), desired: desiredByRing[0] ?? -1,
        worldZ: Math.round(world[2] * 100) / 100, visibility });
    }
  }
  return { bias, samples, desiredHistogram: [...histogram.entries()].sort((a, b) => a[0] - b[0])
    .map(([desired, count]) => ({ desired, count })), replayedPixels: samples.length };
}
