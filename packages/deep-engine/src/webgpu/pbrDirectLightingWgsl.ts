import { MATERIAL_DIELECTRIC_WGSL } from "../materialDielectric.js";
import { PBR_BRDF_DIRECT_LIGHTING_WGSL } from "../lighting/brdfDirectLightingWgsl.js";

/**
 * Direct-light GGX with correlated Smith visibility and no extra texture fetches.
 * J2-B1 单源组合:介电 F0 与 BRDF 两段分别来自 wgsl/materialDielectric.wgsl 与
 * wgsl/brdfDirectLighting.wgsl 的生成镜像,按组合恒等式拼接——
 * `PBR_DIRECT_LIGHTING_WGSL === "\n" + MATERIAL_DIELECTRIC_WGSL + "\n" + PBR_BRDF_DIRECT_LIGHTING_WGSL`,
 * 该恒等式由 brdfDirectLightingWgslChecksum.test.ts 逐字节锁定,迁移前后组合产物零变化。
 */
export const PBR_DIRECT_LIGHTING_WGSL = /* wgsl */ `
${MATERIAL_DIELECTRIC_WGSL}
${PBR_BRDF_DIRECT_LIGHTING_WGSL}`;
