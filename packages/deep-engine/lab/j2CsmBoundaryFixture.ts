export interface CsmBoundaryFixture {
  schema: string; size: number; depths: number[]; blendStarts: number[]; uvXs: number[];
  clearDepths: number[]; edgeRightDepths: number[]; receiverDepth: number; maxError: number;
}
export interface CsmBoundaryCase { blendStart: number; filter: "nearest" | "linear"; pattern: "constant" | "edge" }
export function csmBoundaryCases(fixture: CsmBoundaryFixture): CsmBoundaryCase[] {
  return fixture.blendStarts.flatMap(blendStart => (["nearest", "linear"] as const).flatMap(filter =>
    (["constant", "edge"] as const).map(pattern => ({ blendStart, filter, pattern }))));
}
export function csmBoundaryPoints(fixture: CsmBoundaryFixture) {
  return fixture.uvXs.flatMap(u => fixture.depths.map(depth => ({ u, depth })));
}

/** Independent fixture oracle: compare texels first, then filter comparison results. */
export function referenceCsmVisibility(fixture: CsmBoundaryFixture, row: CsmBoundaryCase, depth: number, u: number): number {
  const compare = (layer: number, x: number, y: number) => {
    const clampedX = Math.max(0, Math.min(fixture.size - 1, x));
    const clampedY = Math.max(0, Math.min(fixture.size - 1, y));
    void clampedY; // Both fixture patterns are constant along y; still evaluate every 2D tap.
    const stored = row.pattern === "edge" && clampedX >= fixture.size / 2
      ? fixture.edgeRightDepths[layer]! : fixture.clearDepths[layer]!;
    return fixture.receiverDepth <= stored ? 1 : 0;
  };
  const filtered = (layer: number, x: number, y: number) => {
    if (row.filter === "nearest") return compare(layer, Math.floor(x * fixture.size), Math.floor(y * fixture.size));
    const px = x * fixture.size - .5, py = y * fixture.size - .5;
    const ix = Math.floor(px), iy = Math.floor(py), fx = px - ix, fy = py - iy;
    const top = compare(layer, ix, iy) * (1 - fx) + compare(layer, ix + 1, iy) * fx;
    const bottom = compare(layer, ix, iy + 1) * (1 - fx) + compare(layer, ix + 1, iy + 1) * fx;
    return top * (1 - fy) + bottom * fy;
  };
  const sample = (layer: number) => {
    let value = 0;
    for (let y = -1; y <= 1; y++) for (let x = -1; x <= 1; x++) value += filtered(layer, u + x / fixture.size, .5 + y / fixture.size);
    return value / 9;
  };
  if (depth > 4) return 1;
  if (depth > 2) return sample(1);
  const current = sample(0);
  if (row.blendStart >= 2 || depth <= row.blendStart) return current;
  const t = Math.max(0, Math.min(1, (depth - row.blendStart) / (2 - row.blendStart))), weight = t * t * (3 - 2 * t);
  return current * (1 - weight) + sample(1) * weight;
}
