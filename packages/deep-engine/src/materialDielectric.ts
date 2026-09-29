/** Legacy PBR uses an exact 0.04 constant; keep that result for the default IOR. */
export function dielectricF0(ior = 1.5): number {
  if (!Number.isFinite(ior) || ior < 1) throw new RangeError("Material IOR must be finite and at least 1.");
  if (ior === 1.5) return 0.04;
  const reflectance = 1 - 2 / (ior + 1);
  return reflectance * reflectance;
}

/**
 * J2-B1 单源:WGSL 文本唯一真源在 `wgsl/materialDielectric.wgsl`,此处只再导出生成镜像
 * (`src/lighting/materialDielectricWgsl.ts`,由 `pnpm --filter @bim-studio/deep-engine wgsl:sync` 生成)。
 * 字节必须保持不变:pbrShader.ts 以本串对 EXTENDED_MATERIAL_EVALUATION_WGSL 做 `.replace()` 手术。
 */
export { MATERIAL_DIELECTRIC_WGSL } from "./lighting/materialDielectricWgsl.js";
