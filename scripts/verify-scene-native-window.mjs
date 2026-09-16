import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { createNativeWindowVerifier } from "./lib/nativeWindowVerifier.mjs";
const requireWeb = createRequire(new URL("../apps/web/package.json", import.meta.url));
const { parseDeepRuntimePackage } = await import(pathToFileURL(requireWeb.resolve("@bim-studio/deep-engine/runtime-package")).href);
export const verifySceneNativeWindow = createNativeWindowVerifier(parseDeepRuntimePackage);
const check = (value, message) => { if (!value) throw new Error(message); };

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const [packagePath, flag, nativeExecutable, ...rest] = process.argv.slice(2);
    check(flag === "--native-executable" && (rest.length === 0 || (rest.length === 2 && rest[0] === "--frames")),
      "用法：node scripts/verify-scene-native-window.mjs <runtime.json> --native-executable <程序路径> [--frames 3]");
    console.log(JSON.stringify(await verifySceneNativeWindow({ packagePath, nativeExecutable, frames: rest.length ? Number(rest[1]) : 3 }), null, 2));
  } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
