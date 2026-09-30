import { displayColorLibrary } from "../shader/displayColorBackends.js";
import { sha256Utf8 } from "../shaderPackage/hash.js";

const marker = "// C8 paired direct tone mapping";
const acesFunction = /vec3 ACESFilmicToneMapping\( vec3 color \) \{[\s\S]*?^\}/gm;
// Actual Three 0.185.1 ACES definition, including its matrix/exposure ordering.
const originalAcesHash = "e33185b708236b7401db999659b876abab6bae06e0049e6d5e5bec288f785281";
let fit: string | undefined;
let displayLibrary: string | undefined;
const fitGuard = "DEEP_C8_PAIRED_THREE_ACES_FIT_V1";

/** Reuse only the existing paired fit, excluding unrelated grading/transfer code. */
function sharedFit() {
  if (fit !== undefined) return fit;
  const source = displayColorLibrary("glsl-es-300").code;
  const start = "vec3 deepThreeAcesFit(";
  const end = "vec3 deepApplyColorGrading(";
  if (source.split(start).length !== 2 || source.split(end).length !== 2
    || source.indexOf(end) <= source.indexOf(start)) throw Error("Paired Three ACES function boundaries changed");
  fit = source.slice(source.indexOf(start), source.indexOf(end)).trimEnd();
  return fit;
}

function guardedFit() {
  return `#ifndef ${fitGuard}\n#define ${fitGuard}\n${sharedFit()}\n#endif`;
}

/** OutputPass includes the same tone chunk: both paths share one guarded definition. */
export function guardedThreeDisplayLibrary(): string {
  if (displayLibrary !== undefined) return displayLibrary;
  displayLibrary = displayColorLibrary("glsl-es-300").code.replace(sharedFit(), guardedFit());
  return displayLibrary;
}

/** Adapt the existing Three r185 shader chunk, before its first compilation. */
export function threeToneMappingShader(source: string): string {
  const matches = [...source.matchAll(acesFunction)];
  const original = matches[0]?.[0];
  if (source.includes(marker) || matches.length !== 1 || !original
    || sha256Utf8(original) !== originalAcesHash) {
    throw Error("Three tone-mapping shader changed or was already adapted");
  }
  return source.replace(acesFunction, `${marker}\n${guardedFit()}\nvec3 ACESFilmicToneMapping( vec3 color ) {\n\treturn deepThreeAcesFit( color, toneMappingExposure );\n}`);
}
