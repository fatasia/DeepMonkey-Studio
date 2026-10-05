import { type PbrFrameReadbackSnapshot } from "./pbrFrameCaptureReadback.js";

/**
 * 帧指纹全量比对(gpui-fast 借鉴项 2,2026-10-05):对连续两帧的同资源 readback 快照
 * 做分块均值指纹与差异定位。用途 = 把"该动的没动"(场景在动但指纹恒定)与"不该动的
 * 动了"(静态场景出现漂移)从肉眼排查变成一次调用;与 gate 的帧时钳制指纹(性能判据)
 * 不同,这里是**内容**指纹,面向渲染诊断。
 *
 * 确定性:同输入逐位同输出(测试钉住)。行填充(readback bytesPerRow 的 256B 对齐 padding)
 * 显式剔除,不参与分块 —— padding 是分配产物不是内容,混入会造成同帧不同指纹。
 * 跨格式/跨尺寸不可比,显式返回 incompatible 而不是硬比。
 */

export interface FrameFingerprint {
  readonly resourceId: string;
  readonly width: number;
  readonly height: number;
  readonly format: string;
  readonly blocksX: number;
  readonly blocksY: number;
  /** 每块 RGBA 通道均值(块顺序 = 行优先),长度 blocksX*blocksY*4。 */
  readonly blockMeans: Float64Array;
  /** FNV-1a 64 位内容指纹(hex),覆盖块均值(四舍五入到 1e-4 抑制浮点噪声)。 */
  readonly hash: string;
}

export interface FrameFingerprintDiff {
  readonly compatible: true;
  readonly changedBlocks: number;
  readonly totalBlocks: number;
  /** 变化块占比 [0,1];0 = 逐位同内容,1 = 全变。 */
  readonly ratio: number;
  /** 最大块差异(任一通道均值的最大绝对差)。 */
  readonly maxBlockDelta: number;
  /** 第一个变化块的 (bx, by);无变化为 undefined。 */
  readonly firstChangedBlock: readonly [number, number] | undefined;
}

export interface FrameFingerprintIncompatible {
  readonly compatible: false;
  readonly reason: string;
}

/** 默认分块:把帧切成约 16×16 块(向下取整,块尺寸 ≥1px)。 */
const TARGET_BLOCKS_PER_AXIS = 16;

function bytesPerPixel(format: string): number | undefined {
  const table: Record<string, number> = {
    "rgba8unorm": 4, "rgba8unorm-srgb": 4, "bgra8unorm": 4, "bgra8unorm-srgb": 4,
    "rgba16float": 8, "rgba32float": 16, "rg11b10ufloat": 4, "rgb10a2unorm": 4,
    "r32float": 4, "r16float": 2, "r8unorm": 1,
  };
  return table[format];
}

function fnv1a64(words: readonly number[]): string {
  // 两个 32 位 lane 模拟 64 位 FNV-1a(位运算安全域),确定性由测试钉住。
  let hi = 0xcbf29ce4, lo = 0x84222325;
  const primeHi = 0x00000100, primeLo = 0x00000193;
  for (const word of words) {
    lo = (Math.imul(lo ^ word, primeLo)) >>> 0;
    hi = (Math.imul(hi ^ (lo >>> 16) ^ word, primeHi)) >>> 0;
  }
  return hi.toString(16).padStart(8, "0") + lo.toString(16).padStart(8, "0");
}

/**
 * 快照 → 分块均值指纹。通道顺序统一为 R,G,B,A(识别 bgra 前缀并交换)。
 * 浮点格式按其原生字节序(f32/f16)读——诊断用途,不做色彩空间换算,同格式下可比即可。
 */
export function frameFingerprint(snapshot: PbrFrameReadbackSnapshot,
  options?: { readonly blocksPerAxis?: number }): FrameFingerprint {
  const bpp = bytesPerPixel(snapshot.format);
  if (bpp === undefined) throw new TypeError(`frame fingerprint: unsupported format ${snapshot.format}.`);
  const perAxis = Math.max(1, Math.floor(options?.blocksPerAxis ?? TARGET_BLOCKS_PER_AXIS));
  const blocksX = Math.min(perAxis, snapshot.width), blocksY = Math.min(perAxis, snapshot.height);
  const blockMeans = new Float64Array(blocksX * blocksY * 4);
  const swapBR = snapshot.format.startsWith("bgra");
  const littleEndian = true;
  for (let by = 0; by < blocksY; by++) {
    const y0 = Math.floor(by * snapshot.height / blocksY), y1 = Math.max(y0 + 1, Math.floor((by + 1) * snapshot.height / blocksY));
    for (let bx = 0; bx < blocksX; bx++) {
      const x0 = Math.floor(bx * snapshot.width / blocksX), x1 = Math.max(x0 + 1, Math.floor((bx + 1) * snapshot.width / blocksX));
      let r = 0, g = 0, b = 0, a = 0, count = 0;
      for (let y = y0; y < y1; y++) {
        const rowBase = y * snapshot.bytesPerRow;
        for (let x = x0; x < x1; x++) {
          const base = rowBase + x * bpp;
          const view = new DataView(snapshot.bytes.buffer, snapshot.bytes.byteOffset + base, bpp);
          let cr: number, cg: number, cb: number, ca: number;
          if (bpp === 4) {
            cr = view.getUint8(0); cg = view.getUint8(1); cb = view.getUint8(2); ca = view.getUint8(3);
            if (swapBR) { const t = cr; cr = cb; cb = t; }
          } else if (bpp === 1) {
            cr = view.getUint8(0); cg = cr; cb = cr; ca = 255;
          } else if (bpp === 2) {
            cr = view.getUint16(0, littleEndian); cg = cr; cb = cr; ca = 1;
          } else if (bpp === 8) {
            cr = view.getUint16(0, littleEndian); cg = view.getUint16(2, littleEndian);
            cb = view.getUint16(4, littleEndian); ca = view.getUint16(6, littleEndian);
          } else {
            cr = view.getUint32(0, littleEndian); cg = view.getUint32(4, littleEndian);
            cb = view.getUint32(8, littleEndian); ca = view.getUint32(12, littleEndian);
          }
          r += cr; g += cg; b += cb; a += ca; count++;
        }
      }
      const out = (by * blocksX + bx) * 4;
      blockMeans[out] = r / count; blockMeans[out + 1] = g / count;
      blockMeans[out + 2] = b / count; blockMeans[out + 3] = a / count;
    }
  }
  const quantized: number[] = [];
  for (let i = 0; i < blockMeans.length; i++) quantized.push(Math.round(blockMeans[i]! * 10000));
  return Object.freeze({
    resourceId: snapshot.resourceId, width: snapshot.width, height: snapshot.height,
    format: snapshot.format, blocksX, blocksY, blockMeans,
    hash: fnv1a64(quantized),
  });
}

/** 两帧指纹比对:同资源同尺寸同格式才可比,否则显式 incompatible。 */
export function compareFrameFingerprints(a: FrameFingerprint, b: FrameFingerprint,
  options?: { readonly deltaThreshold?: number }): FrameFingerprintDiff | FrameFingerprintIncompatible {
  if (a.resourceId !== b.resourceId) return { compatible: false, reason: `resource mismatch: ${a.resourceId} vs ${b.resourceId}` };
  if (a.width !== b.width || a.height !== b.height) return { compatible: false, reason: `size mismatch: ${a.width}x${a.height} vs ${b.width}x${b.height}` };
  if (a.format !== b.format) return { compatible: false, reason: `format mismatch: ${a.format} vs ${b.format}` };
  if (a.blocksX !== b.blocksX || a.blocksY !== b.blocksY) return { compatible: false, reason: "block grid mismatch" };
  const threshold = options?.deltaThreshold ?? 0;
  let changed = 0, maxDelta = 0;
  let first: readonly [number, number] | undefined;
  const total = a.blocksX * a.blocksY;
  for (let block = 0; block < total; block++) {
    let blockDelta = 0;
    for (let channel = 0; channel < 4; channel++) {
      const delta = Math.abs(a.blockMeans[block * 4 + channel]! - b.blockMeans[block * 4 + channel]!);
      if (delta > blockDelta) blockDelta = delta;
    }
    if (blockDelta > maxDelta) maxDelta = blockDelta;
    if (blockDelta > threshold) {
      changed++;
      if (first === undefined) first = [block % a.blocksX, Math.floor(block / a.blocksX)];
    }
  }
  return Object.freeze({ compatible: true, changedBlocks: changed, totalBlocks: total,
    ratio: changed / total, maxBlockDelta: maxDelta, firstChangedBlock: first });
}
