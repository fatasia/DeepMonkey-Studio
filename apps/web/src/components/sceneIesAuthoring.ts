import { parseIesProfile } from "@bim-studio/deep-engine/lighting";
import { quantizeIesLightProfile, runtimeContentSha256 } from "@bim-studio/deep-engine/runtime-package";
import type { SceneLightProfileState } from "@bim-studio/contracts";

export function compileIesAuthorProfile(fileName: string, source: string): SceneLightProfileState {
  const stem = fileName.replace(/\.ies$/i, "").replace(/[^a-z0-9._-]+/gi, "-")
    .replace(/^-+|-+$/g, "").slice(0, 40) || "profile";
  const profileId = `ies-${stem}-${runtimeContentSha256(source).slice(0, 8)}`;
  const profile = quantizeIesLightProfile(profileId, parseIesProfile(source));
  return { ...profile, verticalAngles: [...profile.verticalAngles],
    candela: profile.candela.map((row) => [...row]) };
}
