import { readFileSync, readdirSync } from "node:fs";
import { parseIesProfile } from "../../src/lighting/iesProfile.js";
for (const name of readdirSync(new URL(".", import.meta.url)).filter(n => n.endsWith(".ies"))) {
  try {
    const p = parseIesProfile(readFileSync(new URL(`./${name}`, import.meta.url), "utf8"));
    const h = p.horizontalAngles;
    console.log(name.slice(0, 10), "type", p.photometricType, "v", p.verticalAngles.length, `[${p.verticalAngles[0]}..${p.verticalAngles[p.verticalAngles.length-1]}]`,
      "h", h.length, `[${h[0]}..${h[h.length-1]}]`, "multiplier", p.multiplier);
  } catch (e) { console.log(name.slice(0, 10), "PARSE-FAIL", (e as Error).message); }
}
