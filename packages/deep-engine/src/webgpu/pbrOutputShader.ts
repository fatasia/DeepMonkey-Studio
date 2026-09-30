import { PBR_DISPLAY_COLOR_WGSL } from "./pbrDisplayColorWgsl.js";
import { PBR_AUTHOR_COLOR_EFFECTS_WGSL } from "./pbrAuthorColorEffectsWgsl.js";
import { PBR_OUTPUT_BODY_WGSL } from "./pbrOutputBodyWgsl.js";

export const outputShader = PBR_DISPLAY_COLOR_WGSL + "\n" + PBR_AUTHOR_COLOR_EFFECTS_WGSL + PBR_OUTPUT_BODY_WGSL;
