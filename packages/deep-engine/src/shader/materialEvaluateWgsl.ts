import { MATERIAL_DIELECTRIC_WGSL } from "../materialDielectric.js";
import { EXTENDED_MATERIAL_CORE_WGSL } from "./materialEvaluateCoreWgsl.js";

/** Same T08 pure evaluator; restore the existing dielectric segment at its
 * original position so Browser shader composition stays byte-identical. */
export const EXTENDED_MATERIAL_EVALUATION_WGSL = EXTENDED_MATERIAL_CORE_WGSL.replace(
  "\n\nconst DEEP_MATERIAL_PI:", `${MATERIAL_DIELECTRIC_WGSL}\n\nconst DEEP_MATERIAL_PI:`);
