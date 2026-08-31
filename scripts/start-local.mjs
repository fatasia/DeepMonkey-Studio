import { createConnection } from "node:net";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { desktopDevelopmentArguments } from "./lib/localStartupArguments.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runtimeLogDir = join(repositoryRoot, ".runtime-logs");
const argumentsSet = new Set(process.argv.slice(2));
const target = readOption("--target") ?? "desktop";
const skipInfrastructure = argumentsSet.has("--skip-infra");
const checkOnly = argumentsSet.has("--check");
const noOpen = argumentsSet.has("--no-open");
const supportedTargets = new Set(["desktop", "web", "services"]);
const children = new Set();
let shuttingDown = false;

if (!supportedTargets.has(target)) fail("--target 仅支持 desktop、web 或 services");
if (Number(process.versions.node.split(".")[0]) < 24) fail("需要 Node.js 24 或更高版本");

const environment = { ...process.env, ...readEnvironment(join(repositoryRoot, ".env")) };
const apiPort = positivePort(environment.API_PORT, 4100);
const apiOrigin = configuredApiOrigin(environment, apiPort);
const webPort = 5173;

await main();

async function main() {
  ensureCommand("pnpm", ["--version"]);
  if (!existsSync(join(repositoryRoot, "node_modules"))) fail("依赖尚未安装，请先运行 pnpm install");
  if (!skipInfrastructure) await ensureInfrastructure();

  const summary = {
    target,
    postgres: await canConnect(environment.POSTGRES_HOST ?? "127.0.0.1", positivePort(environment.POSTGRES_PORT, 5432)),
    minio: await endpointReachable(environment.MINIO_ENDPOINT ?? "http://127.0.0.1:9000"),
    api: await apiReachable(apiOrigin),
    web: await canConnect("127.0.0.1", webPort),
  };
  if (checkOnly) {
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    return;
  }

  installShutdownHandlers();
  if (!summary.api) startPnpm(["--filter", "@bim-studio/api", "dev"], "API");

  if (target === "services") {
    await waitForUrl(`${apiOrigin}/api/meta`, "API");
    announce("服务端开发环境已就绪", [`API ${apiOrigin}`]);
  } else if (target === "web") {
    if (!summary.web) startPnpm(["--filter", "@bim-studio/web", "dev"], "Web");
    await Promise.all([
      waitForUrl(`${apiOrigin}/api/meta`, "API"),
      waitForUrl(`http://127.0.0.1:${webPort}`, "Web"),
    ]);
    announce("Web 开发环境已就绪", [`http://127.0.0.1:${webPort}`]);
    if (!noOpen) openAddress(`http://127.0.0.1:${webPort}`);
  } else {
    await waitForUrl(`${apiOrigin}/api/meta`, "API");
    const desktopArgs = desktopDevelopmentArguments(summary.web);
    startPnpm(desktopArgs, "桌面客户端");
    announce("桌面联调环境正在运行", [
      `API ${apiOrigin}`,
      "客户端可选择“本地工作台”，也可连接上述 API",
    ]);
  }

  await waitForChildren();
}

async function ensureInfrastructure() {
  const metadataStore = environment.METADATA_STORE ?? "json";
  if (metadataStore === "postgres") await ensurePostgres();
  const objectStore = environment.OBJECT_STORE ?? "local";
  if (objectStore === "minio") await ensureMinio();
}

async function ensurePostgres() {
  const host = environment.POSTGRES_HOST ?? "127.0.0.1";
  const port = positivePort(environment.POSTGRES_PORT, 5432);
  if (await canConnect(host, port)) return;
  if (!isLoopback(host)) fail(`PostgreSQL ${host}:${port} 不可达，无法代启远程服务`);
  if (process.platform !== "win32") fail("PostgreSQL 未运行，请先启动系统中的 postgresql 服务");

  const command = "$service = Get-Service -Name 'postgresql*' -ErrorAction SilentlyContinue | Select-Object -First 1; if (-not $service) { exit 2 }; if ($service.Status -ne 'Running') { Start-Service -Name $service.Name }";
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], { windowsHide: true, stdio: "ignore" });
  if (result.status !== 0 || !(await waitForPort(host, port, 20_000))) fail("PostgreSQL 未能启动，请检查 Windows 服务和权限");
}

async function ensureMinio() {
  const endpoint = new URL(environment.MINIO_ENDPOINT ?? "http://127.0.0.1:9000");
  if (await canConnect(endpoint.hostname, Number(endpoint.port || 80))) return;
  if (!isLoopback(endpoint.hostname)) fail(`MinIO ${endpoint.origin} 不可达，无法代启远程服务`);

  const mcPath = environment.MINIO_MC_PATH ? resolve(environment.MINIO_MC_PATH) : "";
  const serverPath = environment.MINIO_SERVER_PATH
    ? resolve(environment.MINIO_SERVER_PATH)
    : mcPath ? join(dirname(mcPath), process.platform === "win32" ? "minio.exe" : "minio") : "";
  if (!serverPath || !existsSync(serverPath)) fail("未找到 MinIO，可在 .env 配置 MINIO_SERVER_PATH");
  if (!environment.MINIO_ACCESS_KEY || !environment.MINIO_SECRET_KEY) fail("MinIO 生产凭据未配置");

  mkdirSync(runtimeLogDir, { recursive: true });
  const out = openSync(join(runtimeLogDir, "minio.out.log"), "a");
  const err = openSync(join(runtimeLogDir, "minio.err.log"), "a");
  const dataDir = resolve(environment.MINIO_DATA_DIR ?? join(dirname(dirname(serverPath)), "data"));
  mkdirSync(dataDir, { recursive: true });
  const consolePort = positivePort(environment.MINIO_CONSOLE_PORT, Number(endpoint.port || 9000) + 1);
  const child = spawn(serverPath, ["server", dataDir, "--address", `${endpoint.hostname}:${endpoint.port || 9000}`, "--console-address", `${endpoint.hostname}:${consolePort}`], {
    cwd: repositoryRoot,
    env: { ...environment, MINIO_ROOT_USER: environment.MINIO_ACCESS_KEY, MINIO_ROOT_PASSWORD: environment.MINIO_SECRET_KEY },
    windowsHide: true,
    stdio: ["ignore", out, err],
  });
  child.once("exit", () => { closeSync(out); closeSync(err); });
  trackChild(child, "MinIO");
  if (!(await waitForPort(endpoint.hostname, Number(endpoint.port || 9000), 20_000))) fail("MinIO 未能启动，请查看 .runtime-logs/minio.err.log");
}

function startPnpm(args, label) {
  const invocation = platformCommand("pnpm", args);
  const child = spawn(invocation.command, invocation.args, { cwd: repositoryRoot, env: environment, stdio: "inherit", windowsHide: false });
  trackChild(child, label);
  return child;
}

function trackChild(child, label) {
  child.__label = label;
  children.add(child);
  child.once("exit", (code) => {
    children.delete(child);
    if (!shuttingDown && code && code !== 0) {
      process.stderr.write(`[启动失败] ${label} 退出码 ${code}\n`);
      void shutdown(code);
    }
  });
}

function installShutdownHandlers() {
  process.once("SIGINT", () => void shutdown(0));
  process.once("SIGTERM", () => void shutdown(0));
}

async function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    if (!child.pid || child.killed) continue;
    if (process.platform === "win32") spawnSync("taskkill.exe", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true, stdio: "ignore" });
    else child.kill("SIGTERM");
  }
  process.exitCode = code;
}

async function waitForChildren() {
  while (!shuttingDown && children.size > 0) await new Promise((resolveWait) => setTimeout(resolveWait, 1_000));
}

async function waitForUrl(url, label) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
      if (response.ok) return;
    } catch { /* 服务仍在启动。 */ }
    await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  }
  fail(`${label} 健康检查超时：${url}`);
}

async function endpointReachable(value) {
  try {
    const endpoint = new URL(value);
    return await canConnect(endpoint.hostname, Number(endpoint.port || (endpoint.protocol === "https:" ? 443 : 80)));
  } catch { return false; }
}

async function apiReachable(origin) {
  try {
    const response = await fetch(`${origin}/api/meta`, { signal: AbortSignal.timeout(1_000) });
    return response.ok;
  } catch {
    return false;
  }
}

function canConnect(host, port, timeoutMs = 700) {
  return new Promise((resolveConnection) => {
    const socket = createConnection({ host, port });
    const finish = (value) => { socket.destroy(); resolveConnection(value); };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

async function waitForPort(host, port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await canConnect(host, port)) return true;
    await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  }
  return false;
}

function readEnvironment(path) {
  if (!existsSync(path)) return {};
  return Object.fromEntries(readFileSync(path, "utf8").split(/\r?\n/).flatMap((line) => {
    const match = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match) return [];
    const value = match[2].replace(/^(['"])(.*)\1$/, "$2");
    return [[match[1], value]];
  }));
}

function readOption(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function positivePort(value, fallback) {
  const port = Number(value ?? fallback);
  return Number.isInteger(port) && port > 0 && port <= 65_535 ? port : fallback;
}

function configuredApiOrigin(environment, port) {
  const value = environment.BIM_STUDIO_API_ORIGIN ?? `http://127.0.0.1:${port}`;
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail("BIM_STUDIO_API_ORIGIN 必须是完整的 HTTP(S) 地址");
  }
  if (!parsed || !["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) {
    fail("BIM_STUDIO_API_ORIGIN 必须是不含账号、路径、查询参数或片段的 HTTP(S) Origin");
  }
  return parsed.origin;
}

function isLoopback(host) { return host === "127.0.0.1" || host === "localhost" || host === "::1"; }

function ensureCommand(command, args) {
  const invocation = platformCommand(command, args);
  const result = spawnSync(invocation.command, invocation.args, { windowsHide: true, stdio: "ignore" });
  if (result.status !== 0) fail(`未找到 ${command}，请先安装项目声明的开发环境`);
}

function platformCommand(command, args) {
  if (process.platform !== "win32") return { command, args };
  // 参数均来自上方白名单；通过 cmd 调用 Corepack 的 .cmd shim，避免 Node shell 模式的转义歧义。
  return { command: process.env.ComSpec ?? "cmd.exe", args: ["/d", "/s", "/c", command, ...args] };
}

function openAddress(url) {
  if (process.platform === "win32") spawn("powershell.exe", ["-NoProfile", "-Command", "Start-Process", url], { detached: true, stdio: "ignore" }).unref();
  else if (process.platform === "darwin") spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
  else spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
}

function announce(title, lines) {
  process.stdout.write(`\n${title}\n${lines.map((line) => `  ${line}`).join("\n")}\n  按 Ctrl+C 停止本次启动的进程。\n\n`);
}

function fail(message) {
  throw new Error(message);
}
