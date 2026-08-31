import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";

export const repositoryRoot = path.resolve(import.meta.dirname, "../..");

export function loadProductionEnvironment(environmentPath = path.join(repositoryRoot, ".env")) {
  const envPath = path.resolve(environmentPath);
  const fileValues = existsSync(envPath) ? parseEnvironment(readFileSync(envPath, "utf8")) : {};
  return { envPath, values: { ...fileValues, ...process.env } };
}

export function productionTools(values) {
  const psql = required(values.POSTGRES_PSQL_PATH ?? "psql", "POSTGRES_PSQL_PATH");
  const postgresBin = path.dirname(psql);
  return {
    psql,
    pgDump: siblingExecutable(postgresBin, "pg_dump"),
    pgRestore: siblingExecutable(postgresBin, "pg_restore"),
    mc: required(values.MINIO_MC_PATH ?? "mc", "MINIO_MC_PATH"),
  };
}

export function assertProductionStorage(values) {
  if (values.METADATA_STORE !== "postgres" || values.OBJECT_STORE !== "minio") {
    throw new Error("生产备份只支持 METADATA_STORE=postgres 且 OBJECT_STORE=minio");
  }
  for (const name of ["POSTGRES_PASSWORD", "MINIO_ACCESS_KEY", "MINIO_SECRET_KEY"]) {
    if (!values[name]) throw new Error(`${name} 未配置`);
  }
}

export function postgresArguments(values, database = values.POSTGRES_DATABASE ?? "bim_studio") {
  return [
    "-h", values.POSTGRES_HOST ?? "127.0.0.1",
    "-p", values.POSTGRES_PORT ?? "5432",
    "-U", values.POSTGRES_USER ?? "postgres",
    "-d", database,
  ];
}

export function postgresEnvironment(values, password = values.POSTGRES_PASSWORD) {
  return { ...process.env, PGPASSWORD: password };
}

export function postgresMaintenanceValues(values) {
  return {
    ...values,
    POSTGRES_USER: values.POSTGRES_MAINTENANCE_USER ?? values.POSTGRES_USER,
    POSTGRES_PASSWORD: values.POSTGRES_MAINTENANCE_PASSWORD ?? values.POSTGRES_PASSWORD,
  };
}

export function minioEnvironment(values, alias = "bimops", credentials = {}) {
  const endpoint = new URL(values.MINIO_ENDPOINT ?? "http://127.0.0.1:9000");
  endpoint.username = credentials.accessKey ?? values.MINIO_ACCESS_KEY;
  endpoint.password = credentials.secretKey ?? values.MINIO_SECRET_KEY;
  return {
    ...process.env,
    [`MC_HOST_${alias}`]: endpoint.toString(),
    MC_CONFIG_DIR: path.join(repositoryRoot, "data", "mc-ops-config"),
  };
}

export function minioMaintenanceCredentials(values) {
  return {
    accessKey: values.MINIO_MAINTENANCE_ACCESS_KEY ?? values.MINIO_ACCESS_KEY,
    secretKey: values.MINIO_MAINTENANCE_SECRET_KEY ?? values.MINIO_SECRET_KEY,
  };
}

export async function runNative(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? repositoryRoot,
      env: options.env ?? process.env,
      windowsHide: true,
      shell: false,
      stdio: [options.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { if (stdout.length < 256_000) stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { if (stderr.length < 256_000) stderr += chunk.toString(); });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(sanitizeProcessError(stderr || stdout, command, code, options.redact)));
    });
    if (options.stdin !== undefined) child.stdin.end(options.stdin);
  });
}

export async function apiReachable(values) {
  const port = values.API_PORT ?? "4100";
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/meta`, { signal: AbortSignal.timeout(1_500) });
    return response.ok;
  } catch {
    return false;
  }
}

export async function sha256File(filePath) {
  const content = await readFile(filePath);
  return createHash("sha256").update(content).digest("hex").toUpperCase();
}

export async function inventoryDirectory(directory) {
  const files = await walkFiles(directory);
  return Promise.all(files.map(async (filePath) => ({
    path: path.relative(directory, filePath).split(path.sep).join("/"),
    bytes: (await stat(filePath)).size,
    sha256: await sha256File(filePath),
  })));
}

export async function writeAtomic(filePath, content, mode = 0o600) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporaryPath, content, { encoding: "utf8", mode });
  await rename(temporaryPath, filePath);
}

export function randomSecret(bytes = 32) {
  return randomBytes(bytes).toString("base64url");
}

export function upsertEnvironmentValue(text, key, value) {
  const expression = new RegExp(`^${key}=.*$`, "m");
  return expression.test(text)
    ? text.replace(expression, `${key}=${value}`)
    : `${text.replace(/\s*$/, "")}\n${key}=${value}\n`;
}

export function option(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

export function hasFlag(name) {
  return process.argv.includes(name);
}

export function safeIdentifier(value, label) {
  if (!/^[A-Za-z0-9_]+$/.test(value)) throw new Error(`${label} 只能包含字母、数字和下划线`);
  return value;
}

function siblingExecutable(directory, name) {
  const file = path.join(directory, process.platform === "win32" ? `${name}.exe` : name);
  return required(file, name);
}

function required(command, label) {
  if (path.isAbsolute(command) && !existsSync(command)) throw new Error(`${label} 不可执行：${command}`);
  return command;
}

function parseEnvironment(text) {
  return Object.fromEntries(text.split(/\r?\n/).flatMap((line) => {
    const match = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match) return [];
    return [[match[1], match[2].replace(/^(['"])(.*)\1$/, "$2")]];
  }));
}

async function walkFiles(directory) {
  if (!existsSync(directory)) return [];
  const output = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) output.push(...await walkFiles(entryPath));
    else if (entry.isFile()) output.push(entryPath);
  }
  return output.sort();
}

function sanitizeProcessError(message, command, code, redactions = []) {
  const sanitized = redactions.reduce(
    (text, secret) => secret ? text.replaceAll(secret, "[REDACTED]") : text,
    message,
  );
  const compact = sanitized.trim().slice(0, 4_000);
  return compact || `${path.basename(command)} 退出码 ${String(code)}`;
}
