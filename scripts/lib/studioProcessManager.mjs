import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { isBimStudioApiHealth, isBimStudioWebDocument } from "./localStartupArguments.mjs";
import { readHttpText } from "./localHttpProbe.mjs";
import { probeManagedService } from "./localManagedServices.mjs";
import { loadProductionEnvironment } from "./nativeProductionOps.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const internalRunner = join(repositoryRoot, "scripts", "start-local.mjs");

export function studioRuntimePaths(environment = process.env) {
  const runtimeDirectory = resolve(environment.BIM_STUDIO_RUNTIME_DIR ?? join(repositoryRoot, "data", "runtime"));
  const logDirectory = resolve(environment.BIM_STUDIO_LOG_DIR ?? join(repositoryRoot, "data", "logs"));
  return {
    runtimeDirectory,
    logDirectory,
    stateFile: join(runtimeDirectory, "studio-manager.json"),
    lockFile: join(runtimeDirectory, "studio-manager.lock"),
    readyFile: join(runtimeDirectory, "studio-ready.json"),
    stdoutFile: join(logDirectory, "studio.out.log"),
    stderrFile: join(logDirectory, "studio.err.log"),
  };
}

export function readStudioRuntimeState(paths = studioRuntimePaths()) {
  if (!existsSync(paths.stateFile)) return undefined;
  try {
    const state = JSON.parse(readFileSync(paths.stateFile, "utf8"));
    if (state?.schemaVersion !== 1 || !state.configuration?.target) return undefined;
    return state;
  } catch {
    return undefined;
  }
}

export async function startStudioRuntime(configuration, environment = process.env) {
  const paths = studioRuntimePaths(environment);
  const existing = readStudioRuntimeState(paths);
  if (existing) {
    const status = await getStudioRuntimeStatus(paths, existing);
    if (status.running) throw new Error(`已有 ${existing.configuration.target} 环境在运行；请使用 pnpm studio restart`);
    cleanupRuntimeFiles(paths);
  }

  mkdirSync(paths.runtimeDirectory, { recursive: true });
  mkdirSync(paths.logDirectory, { recursive: true });
  rmSync(paths.readyFile, { force: true });
  const childEnvironment = buildRunnerEnvironment(configuration, environment);
  const runnerTarget = { client: "desktop", web: "web", api: "services" }[configuration.target];
  const args = [internalRunner, "--target", runnerTarget, "--ready-file", paths.readyFile];
  if (configuration.skipInfrastructure) args.push("--skip-infra");
  if (configuration.noOpen) args.push("--no-open");

  const stdout = openSync(paths.stdoutFile, "a");
  const stderr = openSync(paths.stderrFile, "a");
  let child;
  try {
    child = spawn(process.execPath, args, {
      cwd: repositoryRoot,
      env: childEnvironment,
      detached: true,
      stdio: ["ignore", stdout, stderr],
      windowsHide: true,
    });
    child.unref();
  } finally {
    closeSync(stdout);
    closeSync(stderr);
  }

  const startingState = {
    schemaVersion: 1,
    pid: child.pid,
    processStartedAt: readProcessStartedAt(child.pid),
    owned: true,
    status: "starting",
    startedAt: new Date().toISOString(),
    configuration,
  };
  writeState(paths.stateFile, startingState);

  try {
    const ready = await waitForReady(paths, child.pid, 300_000);
    const ownsProcesses = Number(ready.managedProcessCount) > 0;
    const runningState = {
      ...startingState,
      pid: ownsProcesses ? child.pid : null,
      owned: ownsProcesses,
      status: ownsProcesses ? "running" : "external",
      readyAt: ready.readyAt,
      managedServices: ready.managedServices ?? [],
    };
    writeState(paths.stateFile, runningState);
    return { state: runningState, paths };
  } catch (error) {
    await stopSpawnedRuntime(child.pid, paths);
    const detail = tail(paths.stderrFile, 24);
    throw new Error(`${error.message}${detail ? `\n${detail}` : ""}`);
  }
}

export async function stopStudioRuntime(paths = studioRuntimePaths(), options = {}) {
  const state = readStudioRuntimeState(paths);
  if (!state) {
    if (!options.quiet) process.stdout.write("Deep Monkey Studio 当前没有由统一入口管理的运行环境。\n");
    cleanupRuntimeFiles(paths);
    return { stopped: false, external: false };
  }

  if (!state.owned || !state.pid) {
    cleanupRuntimeFiles(paths);
    if (!options.quiet) process.stdout.write("已清除外部服务状态记录；未结束非本入口启动的进程。\n");
    return { stopped: false, external: true };
  }

  if (processIsAlive(state.pid)) {
    if (!verifyRunnerIdentity(state.pid, state)) {
      throw new Error(`PID ${state.pid} 已被其它进程占用，拒绝结束；请检查 ${paths.stateFile}`);
    }
    terminateProcessTree(state.pid);
    await waitForExit(state.pid, 15_000);
  }
  cleanupRuntimeFiles(paths);
  if (!options.quiet) process.stdout.write(`已关闭 ${state.configuration.target} 环境。\n`);
  return { stopped: true, external: false };
}

export async function getStudioRuntimeStatus(paths = studioRuntimePaths(), suppliedState) {
  const state = suppliedState ?? readStudioRuntimeState(paths);
  if (!state) return { state: "stopped", running: false, healthy: false };

  const ownedProcessAlive = state.owned && state.pid ? processIsAlive(state.pid) : false;
  const identityVerified = ownedProcessAlive ? verifyRunnerIdentity(state.pid, state) : false;
  const api = await probeApi(state.configuration);
  const webRequired = state.configuration.target !== "api";
  const web = webRequired ? await probeWeb(state.configuration) : undefined;
  const externallyHealthy = !state.owned && api && (!webRequired || web);
  const running = (ownedProcessAlive && identityVerified) || externallyHealthy;
  const environment = loadProductionEnvironment().values;
  let workerToken = environment.CLOUD_RENDER_WORKER_TOKEN;
  if (!workerToken) {
    try { workerToken = JSON.parse(readFileSync(join(repositoryRoot, "data/cloud-render-worker.json"), "utf8")).token; }
    catch { /* 未配置的 Worker 会由健康检查如实报告异常。 */ }
  }
  const services = await Promise.all((state.managedServices ?? []).map(async service => ({
    id: service.id, label: service.label,
    healthy: await probeManagedService({ ...service, ...(service.id === "cloud-render-worker" ? { headers: { authorization: `Bearer ${workerToken ?? ""}` } } : {}) }),
  })));
  return {
    state: !running ? "stopped" : state.status,
    running,
    healthy: running && api && (!webRequired || web) && services.every(service => service.healthy),
    services,
    owned: Boolean(state.owned),
    pid: state.pid ?? undefined,
    target: state.configuration.target,
    api,
    web,
    configuration: state.configuration,
    identityVerified,
    startedAt: state.startedAt,
    readyAt: state.readyAt,
    logs: { stdout: paths.stdoutFile, stderr: paths.stderrFile },
  };
}

export function buildRunnerEnvironment(configuration, baseEnvironment = process.env) {
  const environment = {
    ...baseEnvironment,
    API_HOST: configuration.apiHost,
    API_PORT: String(configuration.apiPort),
    BIM_STUDIO_API_ORIGIN: configuration.apiOrigin ?? `http://${urlHost(localProbeHost(configuration.apiHost))}:${configuration.apiPort}`,
    BIM_STUDIO_MANAGE_LOCAL_API: configuration.apiOrigin ? "false" : "true",
    BIM_STUDIO_WEB_HOST: configuration.webHost,
    BIM_STUDIO_WEB_PORT: String(configuration.webPort),
    BIM_STUDIO_HTTPS: configuration.https ? "true" : "false",
  };
  if (configuration.metadataStore) environment.METADATA_STORE = configuration.metadataStore;
  if (configuration.objectStore) environment.OBJECT_STORE = configuration.objectStore;
  environment.BIM_STUDIO_CLOUD_WORKER_MANAGED = configuration.cloudWorker ? "true" : "false";
  environment.BIM_STUDIO_CORE_ONLY = configuration.coreOnly ? "true" : "false";
  return environment;
}

export function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function verifyRunnerIdentity(pid, state) {
  const expected = internalRunner.toLowerCase().replaceAll("\\", "/");
  const commandLine = readProcessCommandLine(pid).toLowerCase().replaceAll("\\", "/");
  if (commandLine) return commandLine.includes(expected);
  const actualStart = readProcessStartedAt(pid);
  const expectedStart = state.processStartedAt ?? state.startedAt;
  // 某些受限 Windows 账户不能读取 Win32_Process.CommandLine；启动时间指纹可防止 PID 重用误杀。
  return Boolean(actualStart && expectedStart && Math.abs(Date.parse(actualStart) - Date.parse(expectedStart)) < 5_000);
}

function readProcessCommandLine(pid) {
  if (process.platform === "linux") {
    try { return readFileSync(`/proc/${pid}/cmdline`, "utf8").replaceAll("\0", " "); } catch { return ""; }
  }
  if (process.platform === "win32") {
    const command = `(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').CommandLine`;
    return spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], { encoding: "utf8", windowsHide: true }).stdout ?? "";
  }
  return spawnSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" }).stdout ?? "";
}

function readProcessStartedAt(pid) {
  if (process.platform === "win32") {
    const command = `(Get-Process -Id ${pid}).StartTime.ToUniversalTime().ToString('o')`;
    const value = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], { encoding: "utf8", windowsHide: true }).stdout?.trim();
    return value && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : undefined;
  }
  const value = spawnSync("ps", ["-p", String(pid), "-o", "lstart="], { encoding: "utf8" }).stdout?.trim();
  return value && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : undefined;
}

function terminateProcessTree(pid) {
  if (process.platform === "win32") {
    const result = spawnSync("taskkill.exe", ["/pid", String(pid), "/t", "/f"], { windowsHide: true, stdio: "ignore" });
    if (result.status !== 0 && processIsAlive(pid)) throw new Error(`无法结束 PID ${pid} 的进程树`);
    return;
  }
  try { process.kill(-pid, "SIGTERM"); } catch { process.kill(pid, "SIGTERM"); }
}

async function waitForReady(paths, pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(paths.readyFile)) return JSON.parse(readFileSync(paths.readyFile, "utf8"));
    if (!processIsAlive(pid)) throw new Error("运行进程在就绪前退出");
    await delay(300);
  }
  throw new Error(`启动等待超时，请查看 ${paths.stderrFile}`);
}

async function waitForExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && processTreeIsAlive(pid)) await delay(200);
  if (processTreeIsAlive(pid)) {
    if (process.platform !== "win32") process.kill(-pid, "SIGKILL");
    if (processTreeIsAlive(pid)) throw new Error(`PID ${pid} 的进程树未能在 ${timeoutMs / 1000} 秒内结束`);
  }
}

async function probeApi(configuration) {
  try {
    const origin = configuration.apiOrigin ?? `http://${urlHost(localProbeHost(configuration.apiHost))}:${configuration.apiPort}`;
    const response = await fetch(`${origin}/health`, { signal: AbortSignal.timeout(1_500) });
    return response.ok && isBimStudioApiHealth(await response.json());
  } catch { return false; }
}

async function probeWeb(configuration) {
  try {
    const protocol = configuration.https ? "https" : "http";
    const response = await readHttpText(`${protocol}://${urlHost(localProbeHost(configuration.webHost))}:${configuration.webPort}`, 1_500);
    return response.ok && isBimStudioWebDocument(response.text);
  } catch { return false; }
}

function localProbeHost(host) {
  return host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
}

function urlHost(host) {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

function processTreeIsAlive(pid) {
  if (process.platform === "win32") return processIsAlive(pid);
  try { process.kill(-pid, 0); return true; } catch { return false; }
}

async function stopSpawnedRuntime(pid, paths) {
  if (processIsAlive(pid)) {
    terminateProcessTree(pid);
    await waitForExit(pid, 15_000);
  }
  const current = readStudioRuntimeState(paths);
  if (!current || current.pid === pid) cleanupRuntimeFiles(paths);
}

function writeState(path, state) {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  renameSync(temporary, path);
}

function cleanupRuntimeFiles(paths) {
  rmSync(paths.stateFile, { force: true });
  rmSync(paths.readyFile, { force: true });
}

function tail(path, lines) {
  if (!existsSync(path)) return "";
  return readFileSync(path, "utf8").split(/\r?\n/).slice(-lines).join("\n").trim();
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}
