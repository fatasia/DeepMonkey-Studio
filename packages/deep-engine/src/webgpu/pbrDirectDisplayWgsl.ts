import { PBR_DIFFUSE_IRRADIANCE_WGSL } from "./pbrDiffuseIrradiance.js";
import { PBR_DIRECT_DISPLAY_BODY_WGSL } from "./pbrDirectDisplayBodyWgsl.js";

/** Lean presentation path; library dependencies remain composed at the host boundary. */
export const PBR_DIRECT_DISPLAY_WGSL = "\n" + PBR_DIFFUSE_IRRADIANCE_WGSL + PBR_DIRECT_DISPLAY_BODY_WGSL;
