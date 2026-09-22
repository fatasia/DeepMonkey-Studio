/** v1 custom shaders retain zero in all normal-column padding lanes. */
export type MaterialInstanceAbi = "deep.pbr.mesh.v1" | "deep.pbr.mesh.v5";
export interface MaterialInstanceOptions { readonly materialAbi?: MaterialInstanceAbi }
/** v5 names normalColumn0.w as IOR; zero decodes to legacy IOR 1.5. Stride remains 144B. */
export const MATERIAL_IOR_FLOAT_OFFSET = 15;
export const STOCK_MATERIAL_INSTANCE_OPTIONS = Object.freeze({ materialAbi: "deep.pbr.mesh.v5" } as const);

export function packMaterialIor(ior: number | undefined, options: MaterialInstanceOptions): number {
  const value = ior ?? 1.5;
  if (!Number.isFinite(value) || !Number.isFinite(Math.fround(value)) || value < 1) {
    throw new RangeError("Material IOR must be a finite float32 value at least 1.");
  }
  if (value === 1.5) return 0;
  if (options.materialAbi !== "deep.pbr.mesh.v5") {
    throw new Error("Non-default material IOR requires deep.pbr.mesh.v5; legacy/custom shader ABI does not support it.");
  }
  return value;
}
