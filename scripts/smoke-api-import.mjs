import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

runImportSmoke(
  path.join(workspaceRoot, "apps", "web"),
  "await import('@bim-studio/server-sdk'); await import('@bim-studio/studio-core');"
);
runImportSmoke(
  path.join(workspaceRoot, "packages", "scene-sdk"),
  "await import('@bim-studio/scene-sdk');"
);
runImportSmoke(
  path.join(workspaceRoot, "apps", "api"),
  "await import('./dist/index.js');"
);

console.log("Production package and API imports succeeded");

function runImportSmoke(cwd, source) {
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", source], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, NODE_ENV: "test" }
  });
  if (result.status !== 0) {
    process.stderr.write(result.stdout);
    process.stderr.write(result.stderr);
    process.exit(result.status ?? 1);
  }
}
