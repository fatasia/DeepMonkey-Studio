/** 网格只调制有界反照率；暗部保持细线对比，浅部保留照明前的能量约束。 */
export const GROUND_ALBEDO_WGSL = /* wgsl */ `
fn groundGridAlbedo(baseInput: vec3f, grid: f32, ground: bool) -> vec3f {
  let base = clamp(baseInput, vec3f(0.0), vec3f(1.0));
  let contrast = 0.32 * clamp(grid, 0.0, 1.0);
  return select(baseInput, base + base * (vec3f(1.0) - base) * contrast, ground);
}
`;

/** CPU reference for the production ground-reflectance transfer function. */
export function groundGridAlbedo(base: readonly [number, number, number], grid: number, ground = true): readonly [number, number, number] {
  if (![...base, grid].every(Number.isFinite)) throw new Error("Ground albedo and grid must be finite.");
  if (!ground) return Object.freeze([...base]) as readonly [number, number, number];
  const contrast = 0.32 * Math.max(0, Math.min(1, grid));
  return Object.freeze(base.map(input => {
    const value = Math.max(0, Math.min(1, input));
    return value + value * (1 - value) * contrast;
  }) as [number, number, number]);
}
