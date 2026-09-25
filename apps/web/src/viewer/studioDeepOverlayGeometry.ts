export type OverlayClipPoint = readonly [number, number, number, number];
export type OverlayColor = readonly [number, number, number, number];
/** 顶点预算上限(floats):8 floats/vertex × 196_608 vertices,Deep 原语合并共用。 */
export const OVERLAY_VERTEX_LIMIT = 196_608 * 8;
const LIMIT = OVERLAY_VERTEX_LIMIT;

export function overlayVertex(output: number[], point: OverlayClipPoint, color: OverlayColor): void {
  if (output.length + 8 > LIMIT) throw new Error("Editor overlay geometry exceeds its vertex budget.");
  output.push(...point, ...color);
}

/** Homogeneous clipping retains the visible portion of lines crossing the near plane. */
export function clipOverlayLine(a: OverlayClipPoint, b: OverlayClipPoint): readonly [OverlayClipPoint, OverlayClipPoint] | undefined {
  let start = 0, end = 1;
  for (let axis = 0; axis < 3; axis++) for (const sign of [-1, 1]) {
    const da = a[3] + sign * a[axis]!, db = b[3] + sign * b[axis]!;
    if (da < 0 && db < 0) return undefined;
    if (da < 0) start = Math.max(start, da / (da - db));
    if (db < 0) end = Math.min(end, da / (da - db));
  }
  if (start > end) return undefined;
  const lerp = (t: number): OverlayClipPoint => [0, 1, 2, 3].map(axis => a[axis]! + (b[axis]! - a[axis]!) * t) as unknown as OverlayClipPoint;
  const clipped = [lerp(start), lerp(end)] as const;
  return clipped.some(point => point[3] <= 1e-8) ? undefined : clipped;
}

export function clipOverlayTriangle(points: readonly OverlayClipPoint[]): OverlayClipPoint[] {
  let polygon = [...points];
  for (let axis = 0; axis < 3; axis++) for (const sign of [-1, 1]) {
    const next: OverlayClipPoint[] = [];
    for (let index = 0; index < polygon.length; index++) {
      const a = polygon[index]!, b = polygon[(index + 1) % polygon.length]!;
      const da = a[3] + sign * a[axis]!, db = b[3] + sign * b[axis]!;
      if (da >= 0) next.push(a);
      if ((da < 0) !== (db < 0)) {
        const t = da / (da - db);
        next.push([0, 1, 2, 3].map(component => a[component]! + (b[component]! - a[component]!) * t) as unknown as OverlayClipPoint);
      }
    }
    polygon = next;
  }
  return polygon.filter(point => point[3] > 1e-8);
}

/** Width is in physical framebuffer pixels; transparent edge strips provide one-pixel coverage AA. */
export function overlayLine(output: number[], a: OverlayClipPoint, b: OverlayClipPoint, color: OverlayColor,
  width: number, height: number, lineWidth: number): void {
  const clipped = clipOverlayLine(a, b); if (!clipped) return;
  const [p, q] = clipped;
  const ax = p[0] / p[3], ay = p[1] / p[3], bx = q[0] / q[3], by = q[1] / q[3];
  const dx = (bx - ax) * width, dy = (by - ay) * height, length = Math.hypot(dx, dy);
  if (length < 1e-8) return;
  const nx = -dy / length * 2 / width, ny = dx / length * 2 / height;
  const inner = Math.max(0, lineWidth / 2 - 0.5), outer = lineWidth / 2 + 0.5;
  const point = (end: boolean, offset: number): OverlayClipPoint => [(end ? bx : ax) + nx * offset, (end ? by : ay) + ny * offset, 0, 1];
  const transparent: OverlayColor = [color[0], color[1], color[2], 0];
  for (const [low, high, lowColor, highColor] of [
    [-outer, -inner, transparent, color], [-inner, inner, color, color], [inner, outer, color, transparent],
  ] as const) {
    const vertices = [[false, low, lowColor], [true, low, lowColor], [false, high, highColor],
      [false, high, highColor], [true, low, lowColor], [true, high, highColor]] as const;
    for (const [end, offset, rgba] of vertices) overlayVertex(output, point(end, offset), rgba);
  }
}
