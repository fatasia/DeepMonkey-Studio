import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
export async function loadCsmBoundaryOracle() {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const require = createRequire(import.meta.url), { build } = require("../../packages/deep-engine/node_modules/esbuild");
  const result = await build({ entryPoints: [path.join(root, "packages/deep-engine/lab/j2CsmBoundaryFixture.ts")],
    bundle: true, format: "esm", platform: "node", write: false });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].contents).toString("base64")}`);
}
