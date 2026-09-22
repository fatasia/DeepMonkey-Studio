import { createRequire } from "node:module";
import { copyFile, rename } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = path.join(root, "apps/api/dist/dashboard-static");
const require = createRequire(new URL("../apps/web/package.json", import.meta.url));
const { build } = await import(pathToFileURL(require.resolve("vite")).href);
await build({
  configFile: path.join(root, "apps/web/vite.dashboard-static.config.ts"),
  build: { outDir: output, emptyOutDir: true },
});
await rename(path.join(output, "dashboard-static.html"), path.join(output, "index.html"));
for (const name of ["LICENSE", "THIRD_PARTY_NOTICES.md"])
  await copyFile(path.join(root, name), path.join(output, name));
console.log(`Dashboard static runtime: ${output}`);
