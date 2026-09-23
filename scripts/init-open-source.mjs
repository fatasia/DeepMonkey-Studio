import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { loadProductionEnvironment } from "./lib/nativeProductionOps.mjs";

const root = path.resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const force = args.includes("--force");
const prepareOnly = args.includes("--prepare-only");
const values = loadProductionEnvironment().values;
const dataDirFlagIndex = args.findIndex((value) => value === "--data-dir");
const dataDirArg = args.find((value) => value.startsWith("--data-dir="))?.slice("--data-dir=".length)
  ?? (dataDirFlagIndex >= 0 ? args[dataDirFlagIndex + 1] : undefined);
const dataDir = path.resolve(root, dataDirArg || values.DATA_DIR || "data");
const seed = JSON.parse(await readFile(path.join(root, "examples", "open-source", "database.seed.json"), "utf8"));
const showcases = JSON.parse(await readFile(path.join(root, "examples", "open-source", "showcases.seed.json"), "utf8"));
if (seed.scenes.length || seed.applications.length || !Array.isArray(showcases.scenes) || !Array.isArray(showcases.applications)) throw new Error("open-source seed structure invalid");
seed.scenes = showcases.scenes;
seed.applications = showcases.applications;
const provider = (values.METADATA_STORE ?? "json").toLowerCase();
if (!new Set(["json", "sqlite", "postgres"]).has(provider)) throw new Error(`unsupported METADATA_STORE: ${provider}`);

if (provider === "postgres") await initPostgres(seed, force);
else if (provider === "sqlite") await initSqlite(seed, force);
else await initJson(seed, dataDir, force);
if (!prepareOnly) await startStudio();

async function initJson(document, directory, overwrite) {
  const target = path.join(directory, "database.json");
  if (!overwrite && await exists(target)) { console.log(`open-source JSON metadata already exists: ${path.relative(root, target)}`); return; }
  await mkdir(directory, { recursive: true });
  const temporary = `${target}.open-source-init.tmp`;
  await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, "utf8");
  await rename(temporary, target);
  console.log(`open-source JSON metadata initialized: ${path.relative(root, target)}`);
}

async function initSqlite(document, overwrite) {
  const target = path.resolve(root, values.SQLITE_DATABASE ?? path.join(dataDir, "database.sqlite"));
  await mkdir(path.dirname(target), { recursive: true });
  const database = new DatabaseSync(target);
  try {
    database.exec("CREATE TABLE IF NOT EXISTS bim_studio_state (id INTEGER PRIMARY KEY CHECK (id = 1), document TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)");
    const row = database.prepare("SELECT id FROM bim_studio_state WHERE id = 1").get();
    if (row && !overwrite) { console.log(`open-source SQLite metadata already exists: ${target}`); return; }
    database.prepare("INSERT INTO bim_studio_state (id, document, revision) VALUES (1, ?, 0) ON CONFLICT(id) DO UPDATE SET document = excluded.document, revision = bim_studio_state.revision + 1, updated_at = CURRENT_TIMESTAMP").run(JSON.stringify(document));
    console.log(`open-source SQLite metadata initialized: ${target}`);
  } finally { database.close(); }
}

async function initPostgres(document, overwrite) {
  const pg = { host: values.POSTGRES_HOST ?? "127.0.0.1", port: values.POSTGRES_PORT ?? "5432", user: values.POSTGRES_USER ?? "postgres", database: values.POSTGRES_DATABASE ?? "bim_studio", password: values.POSTGRES_PASSWORD ?? "", psql: values.POSTGRES_PSQL_PATH ?? "psql" };
  if (!/^[A-Za-z0-9_]+$/.test(pg.database)) throw new Error("POSTGRES_DATABASE contains invalid characters");
  const env = { ...values, PGPASSWORD: pg.password };
  const adminArgs = ["-X", "-v", "ON_ERROR_STOP=1", "-h", pg.host, "-p", pg.port, "-U", pg.user, "-d", "postgres", "-t", "-A"];
  const existsResult = await runPsql(pg.psql, adminArgs, env, `SELECT 1 FROM pg_database WHERE datname = '${pg.database}';`);
  if (!existsResult.trim()) await runPsql(pg.psql, adminArgs.filter((value) => value !== "-t" && value !== "-A"), env, `CREATE DATABASE ${pg.database} ENCODING 'UTF8';`);
  const dbArgs = ["-X", "-v", "ON_ERROR_STOP=1", "-h", pg.host, "-p", pg.port, "-U", pg.user, "-d", pg.database, "-t", "-A"];
  await runPsql(pg.psql, dbArgs.filter((value) => value !== "-t" && value !== "-A"), env, "CREATE TABLE IF NOT EXISTS bim_studio_state (id SMALLINT PRIMARY KEY CHECK (id = 1), document JSONB NOT NULL, revision BIGINT NOT NULL DEFAULT 0, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());");
  const row = await runPsql(pg.psql, dbArgs, env, "SELECT 1 FROM bim_studio_state WHERE id = 1;");
  if (row.trim() && !overwrite) { console.log(`open-source PostgreSQL metadata already exists: ${pg.database}`); return; }
  const encoded = Buffer.from(JSON.stringify(document), "utf8").toString("base64");
  const json = `convert_from(decode('${encoded}', 'base64'), 'UTF8')::jsonb`;
  const statement = row.trim() ? `UPDATE bim_studio_state SET document=${json}, revision=revision+1, updated_at=NOW() WHERE id=1;` : `INSERT INTO bim_studio_state(id, document, revision) VALUES (1, ${json}, 0);`;
  await runPsql(pg.psql, dbArgs.filter((value) => value !== "-t" && value !== "-A"), env, statement);
  console.log(`open-source PostgreSQL metadata initialized: ${pg.database}`);
}

function runPsql(command, args, env, statement) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve(stdout) : reject(new Error(stderr.trim() || `psql exited with ${code}`)));
    child.stdin.end(statement);
  });
}

async function exists(file) { try { await access(file); return true; } catch { return false; } }

async function startStudio() {
  const check = await runNode(path.join(root, "scripts", "studio.mjs"), ["check"], values, true);
  if (check === 0) { console.log("Deep Monkey Studio already running and healthy"); return; }
  const startArguments = ["start", "web", "--core-only", "--no-open", "--metadata-store", provider, "--object-store", values.OBJECT_STORE === "minio" ? "minio" : "local"];
  // .env 的 API_PORT / BIM_STUDIO_WEB_PORT 是部署拓扑的权威值（studio check 也按它探测）。
  // 不透传会在默认端口上撞已有实例，造成"种子写入 A、健康检查打到 B"的存储混用。
  if (values.API_PORT) startArguments.push("--api-port", String(values.API_PORT));
  if (values.BIM_STUDIO_WEB_PORT) startArguments.push("--web-port", String(values.BIM_STUDIO_WEB_PORT));
  const childEnvironment = { ...values };
  // --data-dir 是 JSON/SQLite 播种目录；必须同步进子进程，否则启动的实例读默认 data/。
  if (dataDirArg) childEnvironment.DATA_DIR = dataDir;
  await runNode(path.join(root, "scripts", "studio.mjs"), startArguments, childEnvironment);
}

function runNode(script, arguments_, env, allowFailure = false) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...arguments_], { cwd: root, env, stdio: "inherit", windowsHide: true });
    child.on("error", reject);
    child.on("close", (code) => code === 0 || allowFailure ? resolve(code ?? 1) : reject(new Error(`studio command failed with exit code ${code}`)));
  });
}
