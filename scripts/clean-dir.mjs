import { rm } from "node:fs/promises";
import path from "node:path";

const requested = process.argv[2];
if (!requested) throw new Error("Usage: node clean-dir.mjs <directory>");

const workingDirectory = path.resolve(process.cwd());
const target = path.resolve(workingDirectory, requested);
if (path.dirname(target) !== workingDirectory || path.basename(target) !== "dist") {
  throw new Error(`Refusing to remove unexpected directory: ${target}`);
}

await rm(target, { recursive: true, force: true });
