/** Legacy PBR uses an exact 0.04 constant; keep that result for the default IOR. */
export function dielectricF0(ior = 1.5): number {
  if (!Number.isFinite(ior) || ior < 1) throw new RangeError("Material IOR must be finite and at least 1.");
  if (ior === 1.5) return 0.04;
  const reflectance = 1 - 2 / (ior + 1);
  return reflectance * reflectance;
}

/** Stock renderer function; an omitted/zero encoded value preserves the legacy response. */
export const MATERIAL_DIELECTRIC_WGSL = /* wgsl */ `
fn deepDielectricF0(encodedIor: f32) -> f32 {
  if (encodedIor == 0.0 || encodedIor == 1.5) { return 0.04; }
  let reflectance = 1.0 - 2.0 / (encodedIor + 1.0);
  return reflectance * reflectance;
}
`;
