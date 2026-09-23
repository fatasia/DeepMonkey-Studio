import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const dataDirFlagIndex = args.findIndex((value) => value === "--data-dir");
const dataDirArg = args.find((value) => value.startsWith("--data-dir="))?.slice("--data-dir=".length)
  ?? (dataDirFlagIndex >= 0 ? args[dataDirFlagIndex + 1] : undefined);
const dataDir = path.resolve(root, dataDirArg || process.env.DATA_DIR || "data");
const target = path.join(dataDir, "database.json");
const force = args.includes("--force");
const seedPath = path.join(root, "examples", "open-source", "database.seed.json");

const seed = JSON.parse(await readFile(seedPath, "utf8"));
validateSeed(seed);
if (!force && await exists(target)) {
  throw new Error(`database already exists: ${target}; use --force only for a deliberate reset`);
}
await mkdir(dataDir, { recursive: true });
const temporary = `${target}.open-source-seed.tmp`;
await writeFile(temporary, `${JSON.stringify(seed, null, 2)}\n`, "utf8");
await rename(temporary, target);
console.log(`open-source database seed installed: ${path.relative(root, target)}`);
console.log(`projects=${seed.projects.length} models=${seed.projects.reduce((sum, project) => sum + project.models.length, 0)} assets=${seed.projects.reduce((sum, project) => sum + (project.assets?.length ?? 0), 0)}`);

function validateSeed(value) {
  if (!value || typeof value !== "object" || !Array.isArray(value.projects) || !Array.isArray(value.scenes)) throw new Error("invalid database seed: projects and scenes are required");
  for (const project of value.projects) {
    if (!project || typeof project.id !== "string" || !project.id || !Array.isArray(project.models) || !Array.isArray(project.assets)) throw new Error("invalid database seed project");
    for (const connection of project.dataConnections ?? []) {
      if (connection.config?.password || connection.config?.token || connection.config?.apiKey) throw new Error(`seed contains a secret in connection ${connection.id}`);
    }
  }
}

async function exists(file) {
  try { await access(file); return true; }
  catch { return false; }
}
