import { createConnection } from "node:net";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import {
  desktopDevelopmentArguments,
  isBimStudioApiHealth,
  isBimStudioWebDocument,
  localHealthSummary,
  localStartupHelp,
  parseLocalStartupArguments,
} from "./lib/localStartupArguments.mjs";
import { readHttpText } from "./lib/localHttpProbe.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runtimeLogDir = join(repositoryRoot, ".runtime-logs");
const children = new Set();
let shuttingDown = false;
let options;
// 显式进程变量用于 CI、临时诊断和企业终端覆盖；.env 只提供未设置项。
const environment = { ...readEnvironment(join(repositoryRoot, ".env")), ...process.env };
const webPort = positivePort(environment.BIM_STUDIO_WEB_PORT, 5173);
const webHost = environment.BIM_STUDIO_WEB_HOST ?? "0.0.0.0";
let apiPort;
let apiOrigin;

try {
  options = parseLocalStartupArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(localStartupHelp());
  } else {
    if (Number(process.versions.node.split(".")[0]) < 24) fail("需要 Node.js 24 或更高版本");
    apiPort = positivePort(environment.API_PORT, 4100);
    apiOrigin = configuredApiOrigin(environment, apiPort);
    await main();
  }
} catch (error) {
  process.stderr.write(`[Deep Monkey Studio] 启动失败：${error instanceof Error ? error.message : String(error)}\n`);
  await shutdown(1);
}

async function main() {
  const { target, skipInfrastructure, checkOnly, noOpen } = options;
  ensureCommand("pnpm", ["--version"]);
  if (!existsSync(join(repositoryRoot, "node_modules"))) fail("依赖尚未安装，请先运行 pnpm install");
  const localApiExpected = environment.BIM_STUDIO_MANAGE_LOCAL_API === "true"
    || (environment.BIM_STUDIO_MANAGE_LOCAL_API === undefined && managesLocalApi(apiOrigin, apiPort));
  // --check 只读取当前状态，不能因为一次诊断调用而启动基础设施服务。
  if (!checkOnly && !skipInfrastructure && localApiExpected) await ensureInfrastructure();

  const summary = localHealthSummary({
    target,
    // 远程 API 自己负责存储依赖，本机只检查远程 API 身份和当前 Web。
    metadataStore: localApiExpected ? environment.METADATA_STORE ?? "json" : "json",
    objectStore: localApiExpected ? environment.OBJECT_STORE ?? "local" : "local",
    postgres: await canConnect(environment.POSTGRES_HOST ?? "127.0.0.1", positivePort(environment.POSTGRES_PORT, 5432)),
    minio: await endpointReachable(environment.MINIO_ENDPOINT ?? "http://127.0.0.1:9000"),
    api: await apiReachable(apiOrigin),
    web: await webReachable(),
  });
  if (checkOnly) {
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    process.exitCode = summary.healthy ? 0 : 1;
    return;
  }

  installShutdownHandlers();
  if (!summary.api) {
    const apiEndpoint = new URL(apiOrigin);
    const endpointPort = Number(apiEndpoint.port || (apiEndpoint.protocol === "https:" ? 443 : 80));
    if (!isLoopback(apiEndpoint.hostname) || endpointPort !== apiPort) {
      fail(`配置的 API ${apiOrigin} 不可用；远程 API 不会由本地启动器代启`);
    }
    if (await canConnect(apiEndpoint.hostname, endpointPort)) {
      fail(`API 端口 ${endpointPort} 已被非 Deep Monkey Studio 服务占用`);
    }
    startPnpm(["--filter", "@bim-studio/api", "dev"], "API");
  }

  if (target === "services") {
    await waitForApi();
    announce("服务端开发环境已就绪", [`API ${apiOrigin}`]);
    markReady();
  } else if (target === "web") {
    if (!summary.web) {
      if (await canConnect(localProbeHost(webHost), webPort)) fail(`Web 端口 ${webPort} 已被非 Deep Monkey Studio 服务占用`);
      startPnpm(["--filter", "@bim-studio/web", "dev"], "Web");
    }
    await Promise.all([
      waitForApi(),
      waitForWeb(),
    ]);
    const webOrigin = configuredWebOrigin();
    announce("Web 开发环境已就绪", [webOrigin]);
    markReady();
    if (!noOpen) openAddress(webOrigin);
  } else {
    await waitForApi();
    if (!summary.web && await canConnect(localProbeHost(webHost), webPort)) fail(`Web 端口 ${webPort} 已被非 Deep Monkey Studio 服务占用`);
    const desktopArgs = desktopDevelopmentArguments(summary.web);
    startPnpm(desktopArgs, "桌面客户端");
    await waitForWeb();
    announce("桌面联调环境正在运行", [
      `API ${apiOrigin}`,
      "客户端可选择“本地工作台”，也可连接上述 API",
    ]);
    markReady();
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
    detached: process.platform !== "win32",
    stdio: ["ignore", out, err],
  });
  child.once("exit", () => { closeSync(out); closeSync(err); });
  trackChild(child, "MinIO");
  if (!(await waitForPort(endpoint.hostname, Number(endpoint.port || 9000), 20_000))) fail("MinIO 未能启动，请查看 .runtime-logs/minio.err.log");
}

function startPnpm(args, label) {
  const invocation = platformCommand("pnpm", args);
  const child = spawn(invocation.command, invocation.args, {
    cwd: repositoryRoot,
    env: environment,
    stdio: "inherit",
    windowsHide: false,
    detached: process.platform !== "win32",
  });
  trackChild(child, label);
  return child;
}

function trackChild(child, label) {
  child.__label = label;
  children.add(child);
  child.once("exit", (code) => {
    children.delete(child);
    if (!shuttingDown) {
      // 任一受管核心进程退出都结束同一运行环境，避免状态显示健康但客户端或 Web 已经消失。
      const exitCode = code && code !== 0 ? code : 1;
      process.stderr.write(`[运行中断] ${label} 已退出（退出码 ${code ?? "unknown"}）\n`);
      void shutdown(exitCode);
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
  const activeChildren = [...children].filter((child) => child.pid && !child.killed);
  for (const child of activeChildren) terminateChildTree(child.pid, "SIGTERM");
  await waitForChildTrees(activeChildren, 5_000);
  for (const child of activeChildren) {
    if (childTreeIsAlive(child.pid)) terminateChildTree(child.pid, "SIGKILL");
  }
  process.exitCode = code;
}

async function waitForChildren() {
  while (!shuttingDown && children.size > 0) await new Promise((resolveWait) => setTimeout(resolveWait, 1_000));
}

async function waitForApi() {
  return waitForProbe(() => apiReachable(apiOrigin), "API", `${apiOrigin}/health`);
}

async function waitForWeb() {
  return waitForProbe(webReachable, "Web", configuredWebOrigin());
}

async function waitForProbe(probe, label, url) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (await probe()) return;
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
    const response = await fetch(`${origin}/health`, { signal: AbortSignal.timeout(1_000) });
    return response.ok && isBimStudioApiHealth(await response.json());
  } catch {
    return false;
  }
}

async function webReachable() {
  try {
    const response = await readHttpText(configuredWebOrigin(), 1_000);
    return response.ok && isBimStudioWebDocument(response.text);
  } catch {
    return false;
  }
}

function canConnect(host, port, timeoutMs = 700) {
  return new Promise((resolveConnection) => {
    const socket = createConnection({ host, port });
    // 探测连接不是业务长连接，立即 unref 避免 --check 在失败/半开连接上挂住进程。
    socket.unref();
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      socket.removeAllListeners();
      socket.destroy();
      resolveConnection(value);
    };
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

function managesLocalApi(origin, port) {
  const endpoint = new URL(origin);
  const endpointPort = Number(endpoint.port || (endpoint.protocol === "https:" ? 443 : 80));
  return isLoopback(endpoint.hostname) && endpointPort === port;
}

function configuredWebOrigin() {
  const protocol = environment.BIM_STUDIO_HTTPS === "true" ? "https" : "http";
  return `${protocol}://${urlHost(localProbeHost(webHost))}:${webPort}`;
}

function localProbeHost(host) {
  return host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
}

function urlHost(host) {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

function terminateChildTree(pid, signal) {
  if (process.platform === "win32") {
    spawnSync("taskkill.exe", ["/pid", String(pid), "/t", "/f"], { windowsHide: true, stdio: "ignore" });
    return;
  }
  try { process.kill(-pid, signal); } catch { /* 子进程可能已在并发退出。 */ }
}

function childTreeIsAlive(pid) {
  if (process.platform === "win32") {
    try { process.kill(pid, 0); return true; } catch { return false; }
  }
  try { process.kill(-pid, 0); return true; } catch { return false; }
}

async function waitForChildTrees(activeChildren, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && activeChildren.some((child) => childTreeIsAlive(child.pid))) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
}

function markReady() {
  if (!options.readyFile) return;
  mkdirSync(dirname(options.readyFile), { recursive: true });
  // 统一入口据此区分“本次管理的进程”和“启动前已存在的外部服务”。
  writeFileSync(options.readyFile, `${JSON.stringify({
    readyAt: new Date().toISOString(),
    managedProcessCount: children.size,
    target: options.target,
  }, null, 2)}\n`, "utf8");
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
