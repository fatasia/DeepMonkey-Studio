import { parseStudioArguments, resolveStudioConfiguration, studioHelp } from "./lib/studioCliArguments.mjs";
import {
  getStudioRuntimeStatus,
  readStudioRuntimeState,
  startStudioRuntime,
  stopStudioRuntime,
  studioRuntimePaths,
} from "./lib/studioProcessManager.mjs";
import { getStudioDeploymentStatus, printStudioDeploymentStatus, runStudioDeployment } from "./lib/studioDeployment.mjs";
import { loadProductionEnvironment } from "./lib/nativeProductionOps.mjs";
import { withStudioOperationLock } from "./lib/studioOperationLock.mjs";

try {
  await main();
} catch (error) {
  process.stderr.write(`[Deep Monkey Studio] ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}

async function main() {
  const parsed = parseStudioArguments(process.argv.slice(2));
  if (parsed.action === "help") {
    process.stdout.write(studioHelp());
    return;
  }
  ensureNodeVersion();
  if (parsed.action === "deploy" || parsed.action === "undeploy") {
    runStudioDeployment(parsed.action, parsed);
    return;
  }

  const paths = studioRuntimePaths();
  if (parsed.action === "stop") {
    await withStudioOperationLock(paths.lockFile, async () => {
      const current = readStudioRuntimeState(paths);
      assertRequestedTarget(parsed, current);
      await stopStudioRuntime(paths);
    });
    return;
  }
  if (parsed.action === "status" || parsed.action === "check") {
    const current = readStudioRuntimeState(paths);
    assertRequestedTarget(parsed, current);
    const status = await getStudioRuntimeStatus(paths, current);
    if (status.running) printStatus(status);
    const productionStatus = status.running ? undefined : await getStudioDeploymentStatus();
    if (productionStatus) printStudioDeploymentStatus(productionStatus);
    if (parsed.action === "check" && !(status.running ? status.healthy : productionStatus.healthy)) process.exitCode = 1;
    return;
  }
  await withStudioOperationLock(paths.lockFile, async () => {
    const current = readStudioRuntimeState(paths);
    assertRequestedTarget(parsed, current);
    if (parsed.action === "restart") await stopStudioRuntime(paths, { quiet: true });
    const configuration = resolveStudioConfiguration(parsed, current?.configuration, process.platform, loadProductionEnvironment().values);
    const result = await startStudioRuntime(configuration);
    printStatus(await getStudioRuntimeStatus(result.paths, result.state));
  });
}

function assertRequestedTarget(parsed, current) {
  if (!parsed.explicitTarget || !current) return;
  if (["stop", "status", "check"].includes(parsed.action) && parsed.target !== current.configuration.target) {
    throw new Error(`当前运行的是 ${current.configuration.target}，不是 ${parsed.target}`);
  }
}

function printStatus(status) {
  if (!status.running) {
    process.stdout.write("\nDeep Monkey Studio：未运行\n\n");
    return;
  }
  const ownership = status.owned ? `PID ${status.pid}` : "外部服务（仅跟踪，不接管进程）";
  const configuration = status.configuration;
  const apiOrigin = configuration.apiOrigin ?? `http://${urlHost(displayHost(configuration.apiHost))}:${configuration.apiPort}`;
  const lines = [
    `模式      ${status.target}`,
    `状态      ${status.healthy ? "健康" : "异常"}`,
    `进程      ${ownership}`,
    `API       ${status.api ? "正常" : "异常"} · ${apiOrigin}`,
  ];
  if (status.target !== "api") {
    const protocol = configuration.https ? "https" : "http";
    lines.push(`Web       ${status.web ? "正常" : "异常"} · ${protocol}://${urlHost(displayHost(configuration.webHost))}:${configuration.webPort}`);
  }
  if (configuration.cloudWorker) {
    lines.push("云渲染    本地 GPU Worker 随栈启动（--cloud-worker）");
  }
  lines.push(`日志      ${status.logs.stderr}`);
  process.stdout.write(`\nDeep Monkey Studio 运行状态\n${lines.map((line) => `  ${line}`).join("\n")}\n\n`);
}

function displayHost(host) {
  return host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
}

function urlHost(host) {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

function ensureNodeVersion() {
  if (Number(process.versions.node.split(".")[0]) < 24) throw new Error("需要 Node.js 24 或更高版本");
}
