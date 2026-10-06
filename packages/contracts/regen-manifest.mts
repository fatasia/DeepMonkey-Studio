import { writeFileSync } from "node:fs";
import { rendererCapabilityManifestJson } from "./src/rendererCapabilityManifest.js";
writeFileSync(new URL("./fixtures/renderer-capability-manifest.json", import.meta.url), rendererCapabilityManifestJson());
console.log("golden regenerated");
