/** FXAA reference adapted from Three r185; see spatialAa.LICENSE.md. Display-encoded, premultiplied RGBA only. */
export interface SpatialAaImage { readonly width: number; readonly height: number; readonly color: ArrayLike<number> }
const steps = [1, 1.5, 2, 2, 2, 4];
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));
export function resolveSpatialAaCpu(image: SpatialAaImage): Float32Array {
  const { width, height, color } = image;
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1
    || width * height > 16_777_216 || color.length !== width * height * 4) throw new Error("Invalid spatial AA image dimensions.");
  for (let i = 0; i < color.length; i++) if (!Number.isFinite(color[i]) || color[i]! < 0 || color[i]! > 1) {
    throw new Error("Spatial AA requires finite display-encoded RGBA inside [0, 1].");
  }
  const sample = (x: number, y: number): number[] => {
    const bx = Math.floor(x), by = Math.floor(y), fx = x - bx, fy = y - by, result = [0, 0, 0, 0];
    for (let j = 0; j < 2; j++) for (let i = 0; i < 2; i++) {
      const p = (clamp(by + j, 0, height - 1) * width + clamp(bx + i, 0, width - 1)) * 4;
      const weight = (i ? fx : 1 - fx) * (j ? fy : 1 - fy);
      for (let c = 0; c < 4; c++) result[c] = result[c]! + color[p + c]! * weight;
    }
    return result;
  };
  const luma = (x: number, y: number) => { const c = sample(x, y); return c[0]! * .3 + c[1]! * .59 + c[2]! * .11; };
  const output = new Float32Array(color.length);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const m = luma(x, y), n = luma(x, y + 1), e = luma(x + 1, y), s = luma(x, y - 1), w = luma(x - 1, y);
    const high = Math.max(m, n, e, s, w), contrast = high - Math.min(m, n, e, s, w);
    if (contrast < Math.max(.0312, .063 * high)) { output.set(sample(x, y), (y * width + x) * 4); continue; }
    const ne = luma(x + 1, y + 1), nw = luma(x - 1, y + 1), se = luma(x + 1, y - 1), sw = luma(x - 1, y - 1);
    const f = clamp(Math.abs((2 * (n + e + s + w) + ne + nw + se + sw) / 12 - m) / contrast, 0, 1);
    const smooth = f * f * (3 - 2 * f), pixelBlend = smooth * smooth;
    const horizontal = Math.abs(n + s - 2 * m) * 2 + Math.abs(ne + se - 2 * e) + Math.abs(nw + sw - 2 * w)
      >= Math.abs(e + w - 2 * m) * 2 + Math.abs(ne + nw - 2 * n) + Math.abs(se + sw - 2 * s);
    const positive = horizontal ? n : e, negative = horizontal ? s : w;
    const sign = Math.abs(positive - m) < Math.abs(negative - m) ? -1 : 1;
    const opposite = sign < 0 ? negative : positive, threshold = Math.abs(opposite - m) * .25, edgeLuma = (m + opposite) * .5;
    const edgeX = x + (horizontal ? 0 : sign * .5), edgeY = y + (horizontal ? sign * .5 : 0);
    const search = (direction: number) => {
      let distance = 0, delta = 0, found = false;
      for (const step of steps) { distance += step;
        delta = luma(edgeX + (horizontal ? direction * distance : 0), edgeY + (horizontal ? 0 : direction * distance)) - edgeLuma;
        if (Math.abs(delta) >= threshold) { found = true; break; }
      }
      if (!found) distance += 8;
      return { distance, delta };
    };
    const p = search(1), q = search(-1), nearest = p.distance <= q.distance ? p : q;
    const edgeBlend = (nearest.delta >= 0) === (m - edgeLuma >= 0) ? 0 : .5 - nearest.distance / (p.distance + q.distance);
    const blend = Math.max(pixelBlend, edgeBlend);
    output.set(sample(x + (horizontal ? 0 : sign * blend), y + (horizontal ? sign * blend : 0)), (y * width + x) * 4);
  }
  return output;
}
