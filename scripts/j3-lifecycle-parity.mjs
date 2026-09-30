import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { compareLifecycleTraces } from "./lib/j3LifecycleParity.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const out = path.join(root, "test-output/interrupted-0930/lifecycle-parity");
const flags = new Set(process.argv.slice(2));
for (const flag of flags) if (!["--web-only", "--compare"].includes(flag)) throw new Error(`Unknown option ${flag}`);
if (flags.size > 1) throw new Error("Choose --web-only or --compare");
await mkdir(out, { recursive: true });
const fixture = JSON.parse(await readFile(path.join(root, "packages/deep-engine/fixtures/j3-lifecycle-v1.json"), "utf8"));
const webPath = path.join(out, "web.json"), nativePath = path.join(out, "native.json");
if (!flags.has("--compare")) {
  const require = createRequire(import.meta.url);
  const { build } = require("../packages/deep-engine/node_modules/esbuild");
  const probePath = path.join(out, "probe.mjs");
  await build({ entryPoints: [path.join(root, "packages/deep-engine/lab/j3LifecycleProbe.ts")],
    outfile: probePath, bundle: true, platform: "node", format: "esm" });
  const { runJ3LifecycleProbe } = await import(pathToFileURL(probePath).href);
  const first = await runJ3LifecycleProbe(fixture), second = await runJ3LifecycleProbe(fixture);
  await writeFile(webPath, JSON.stringify({ host: first.host, scope: first.scope, fixture,
    runs: [first.scenarios, second.scenarios] }, null, 2));
  if (!flags.has("--web-only")) {
    await rm(nativePath, { force: true });
    const cargo = spawnSync("cargo", ["test", "--manifest-path", "packages/deep-engine-native/Cargo.toml",
      "--locked", "--test", "j3_lifecycle_parity", "--", "--nocapture"], {
      cwd: root, env: { ...process.env, J3_NATIVE_LIFECYCLE_OUTPUT_PATH: nativePath },
      encoding: "utf8", windowsHide: true, timeout: 600000,
    });
    await writeFile(path.join(out, "native.log"), (cargo.stdout ?? "") + (cargo.stderr ?? ""));
    if (cargo.error || cargo.status !== 0) throw new Error(`Native lifecycle leg failed (${cargo.status}): ${cargo.error?.message ?? "see native.log"}`);
  }
}
if (flags.has("--web-only")) console.log(`TS lifecycle trace: ${webPath}`);
else {
  const web = JSON.parse(await readFile(webPath, "utf8"));
  const native = JSON.parse(await readFile(nativePath, "utf8"));
  const evidence = compareLifecycleTraces(fixture, web, native);
  await writeFile(path.join(out, "evidence.json"), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence, null, 2));
}
