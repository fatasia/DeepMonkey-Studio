const ACTIONS = new Set(["start", "stop", "restart", "status", "check", "deploy", "undeploy", "help"]);
const TARGETS = new Set(["client", "web", "api"]);
const STORE_OPTIONS = {
  "--metadata-store": new Set(["json", "postgres"]),
  "--object-store": new Set(["local", "minio"]),
};

/**
 * 统一入口只暴露“客户端 / Web / API”三个用户目标。
 * PostgreSQL 与 MinIO 是否参与启动，由存储模式决定，避免用户理解服务依赖图。
 */
export function parseStudioArguments(argv, platform = process.platform) {
  const options = {
    action: "help",
    target: undefined,
    explicitTarget: false,
    overrides: {},
    skipInfrastructure: false,
    noOpen: platform === "linux",
    https: false,
    cloudWorker: undefined,
    coreOnly: undefined,
    deploymentCheck: false,
    skipBuild: false,
  };

  if (argv.length === 0) return options;
  if (argv[0] === "--help" || argv[0] === "-h") return options;
  const [action, possibleTarget, ...remaining] = argv;
  if (!ACTIONS.has(action)) throw new Error(`未知操作：${action}`);
  options.action = action;
  if (action === "help") {
    if (argv.length > 1) throw new Error("help 不接受其它参数");
    return options;
  }

  let argumentsToParse = [possibleTarget, ...remaining].filter((value) => value !== undefined);
  if (action === "deploy" || action === "undeploy") {
    for (const argument of argumentsToParse) {
      if (action === "deploy" && argument === "--check") options.deploymentCheck = true;
      else if (action === "deploy" && argument === "--skip-build") options.skipBuild = true;
      else throw new Error(`${action} 不支持参数：${argument}`);
    }
    return options;
  }
  if (argumentsToParse[0] && !argumentsToParse[0].startsWith("-")) {
    const target = normalizeTarget(argumentsToParse.shift());
    if (!TARGETS.has(target)) throw new Error(`未知目标：${target}`);
    options.target = target;
    options.explicitTarget = true;
  }
  if (["stop", "status", "check"].includes(action) && argumentsToParse.length > 0) {
    throw new Error(`${action} 只接受可选的 client、web 或 api 目标`);
  }

  for (let index = 0; index < argumentsToParse.length; index += 1) {
    const argument = argumentsToParse[index];
    if (argument === "--skip-infra") options.skipInfrastructure = true;
    else if (argument === "--no-open") options.noOpen = true;
    else if (argument === "--https") options.https = true;
    else if (argument === "--cloud-worker") options.cloudWorker = true;
    else if (argument === "--no-cloud-worker") options.cloudWorker = false;
    else if (argument === "--core-only") options.coreOnly = true;
    else if (argument === "--full-services") options.coreOnly = false;
    else if (argument === "--api-port") options.overrides.apiPort = readPort(argumentsToParse, ++index, argument);
    else if (argument === "--web-port") options.overrides.webPort = readPort(argumentsToParse, ++index, argument);
    else if (argument === "--api-host") options.overrides.apiHost = readHost(argumentsToParse, ++index, argument);
    else if (argument === "--web-host") options.overrides.webHost = readHost(argumentsToParse, ++index, argument);
    else if (argument === "--api-origin") options.overrides.apiOrigin = readOrigin(argumentsToParse, ++index, argument);
    else if (STORE_OPTIONS[argument]) {
      const value = readValue(argumentsToParse, ++index, argument);
      if (!STORE_OPTIONS[argument].has(value)) throw new Error(`${argument} 不支持 ${value}`);
      const key = argument === "--metadata-store" ? "metadataStore" : "objectStore";
      options.overrides[key] = value;
    } else throw new Error(`未知参数：${argument}`);
  }
  return options;
}

/** 合并重启前的配置，让 `restart` 不带参数时能准确复用上次启动方式。 */
export function resolveStudioConfiguration(parsed, previous, platform = process.platform, environment = process.env) {
  const defaults = {
    target: defaultTarget(platform),
    apiHost: "0.0.0.0",
    apiPort: 4100,
    apiOrigin: undefined,
    webHost: "0.0.0.0",
    webPort: 5173,
    metadataStore: undefined,
    objectStore: undefined,
    skipInfrastructure: false,
    noOpen: platform === "linux",
    https: false,
    cloudWorker: false,
    coreOnly: false,
  };
  const reusablePrevious = parsed.action === "restart" ? previous : undefined;
  const configuration = {
    ...defaults,
    ...reusablePrevious,
    ...parsed.overrides,
    target: parsed.explicitTarget ? parsed.target : reusablePrevious?.target ?? defaults.target,
    skipInfrastructure: parsed.skipInfrastructure || reusablePrevious?.skipInfrastructure || false,
    noOpen: parsed.noOpen || reusablePrevious?.noOpen || defaults.noOpen,
    https: parsed.https || reusablePrevious?.https || false,
    cloudWorker: parsed.cloudWorker ?? reusablePrevious?.cloudWorker ?? ((parsed.target ?? reusablePrevious?.target ?? defaults.target) !== "api"),
    coreOnly: parsed.coreOnly ?? reusablePrevious?.coreOnly ?? false,
    // .env 是存储拓扑的权威配置。显式 CLI 参数优先，其次当前 .env，最后才复用旧运行状态；
    // 避免一次 JSON 测试运行让后续无参数 restart 悄悄隐藏 PostgreSQL 中的真实项目。
    metadataStore: parsed.overrides.metadataStore ?? environment.METADATA_STORE ?? reusablePrevious?.metadataStore,
    objectStore: parsed.overrides.objectStore ?? environment.OBJECT_STORE ?? reusablePrevious?.objectStore,
  };

  if (configuration.target === "client" && platform !== "win32") {
    throw new Error("客户端开发模式当前仅支持 Windows；Linux 服务器请使用 web 或 api");
  }
  if (configuration.target === "client" && configuration.webPort !== 5173) {
    throw new Error("客户端开发模式的 Web 端口固定为 5173；Web 服务器模式可使用 --web-port 自定义");
  }
  if (configuration.target === "client" && configuration.https) {
    throw new Error("客户端开发模式暂不支持 --https；HTTPS 请使用 web 模式");
  }
  return configuration;
}

export function studioHelp() {
  return `Deep Monkey Studio 统一运行入口（Windows / Linux）

用法：
  pnpm studio start [client|web|api] [选项]
  pnpm studio stop
  pnpm studio restart [client|web|api] [选项]
  pnpm studio status
  pnpm studio check
  pnpm studio deploy [--check] [--skip-build]
  pnpm studio undeploy
  pnpm studio help

目标：
  client  API + Web + Windows 桌面客户端（Windows 默认）
  web     API + Web 开发服务器（Linux 默认）
  api     仅 API 及其配置要求的 PostgreSQL / MinIO

常用选项：
  --api-host <地址>             API 监听地址，默认 0.0.0.0
  --api-port <端口>             API 端口，默认 4100
  --api-origin <HTTP(S) Origin> 使用已有远程 API；Web 不再代启本地 API
  --web-host <地址>             Web 监听地址，默认 0.0.0.0
  --web-port <端口>             Web 端口，默认 5173
  --metadata-store json|postgres
  --object-store local|minio
  --skip-infra                  不代启本地 PostgreSQL / MinIO
  --https                       Web 模式使用 .env 中配置的 HTTPS 证书
  --cloud-worker                启用云渲染 Worker（Web/客户端默认启用）
  --no-cloud-worker             关闭云渲染，保留流程与实时视频服务
  --core-only                   精简启动，仅启动 API/Web 及存储
  --full-services               恢复默认全服务启动（含流程、视频、云渲染）
  --no-open                     就绪后不打开浏览器

示例：
  pnpm studio start client
  pnpm studio start web --api-port 4200 --web-port 5200
  pnpm studio start api --metadata-store postgres --object-store minio
  pnpm studio restart
  pnpm studio stop
  pnpm studio deploy --check
`;
}

export function defaultTarget(platform = process.platform) {
  return platform === "win32" ? "client" : "web";
}

function normalizeTarget(value) {
  // 仅为旧命令保留语义兼容，不在帮助中形成第二套概念。
  if (value === "desktop" || value === "app") return "client";
  if (value === "services") return "api";
  return value;
}

function readValue(argv, index, option) {
  const value = argv[index];
  if (!value || value.startsWith("--")) throw new Error(`${option} 后必须提供值`);
  return value;
}

function readPort(argv, index, option) {
  const value = Number(readValue(argv, index, option));
  if (!Number.isInteger(value) || value < 1 || value > 65_535) throw new Error(`${option} 必须是 1-65535 的整数`);
  return value;
}

function readHost(argv, index, option) {
  const value = readValue(argv, index, option).trim();
  if (!value || /[\s/]/.test(value)) throw new Error(`${option} 必须是主机名或 IP 地址`);
  return value;
}

function readOrigin(argv, index, option) {
  const value = readValue(argv, index, option);
  let parsed;
  try { parsed = new URL(value); } catch { throw new Error(`${option} 必须是完整的 HTTP(S) Origin`); }
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new Error(`${option} 必须是不含账号、路径、查询参数或片段的 HTTP(S) Origin`);
  }
  return parsed.origin;
}
