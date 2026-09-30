import { guardedThreeDisplayLibrary } from "./threeToneMappingShader.js";

const acesCall = "ACESFilmicToneMapping( gl_FragColor.rgb )";
const mainDeclaration = "void main()";
const marker = "// C8 paired display output";

/** Assemble once when constructing the existing Three OutputPass. */
export function threeDisplayOutputShader(fragmentShader: string): string {
  if (fragmentShader.includes(marker)
    || fragmentShader.split(acesCall).length !== 2
    || fragmentShader.split(mainDeclaration).length !== 2) {
    throw new Error("Three OutputPass shader changed or was already adapted");
  }
  const library = guardedThreeDisplayLibrary();
  return fragmentShader.replace(acesCall, "deepThreeAcesFit( gl_FragColor.rgb, toneMappingExposure )")
    .replace(mainDeclaration, `${marker}\n${library}\n${mainDeclaration}`);
}
