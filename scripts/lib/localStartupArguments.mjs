/** pnpm 会把脚本名后的参数直接传给 Tauri；额外的 `--` 会误落到 Cargo。 */
export function desktopDevelopmentArguments(webAlreadyRunning) {
  return [
    "--filter",
    "@bim-studio/desktop",
    "dev",
    ...(webAlreadyRunning ? ["--config", "src-tauri/tauri.existing-dev.conf.json"] : []),
  ];
}

const SUPPORTED_TARGETS = new Set(["desktop", "web", "services"]);

/**
 * 本地启动器是交付入口，未知参数必须立即失败，不能像普通开发脚本一样静默忽略。
 */
export function parseLocalStartupArguments(argv) {
  const options = {
    target: "desktop",
    skipInfrastructure: false,
    checkOnly: false,
    noOpen: false,
    help: false,
    readyFile: undefined,
  };
  let targetSeen = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--target") {
      if (targetSeen) throw new Error("--target 只能指定一次");
      const value = argv[index + 1];
      if (!value || value.startsWith("-")) throw new Error("--target 后必须指定 desktop、web 或 services");
      if (!SUPPORTED_TARGETS.has(value)) throw new Error("--target 仅支持 desktop、web 或 services");
      options.target = value;
      targetSeen = true;
      index += 1;
      continue;
    }
    if (argument === "--skip-infra") options.skipInfrastructure = true;
    else if (argument === "--check") options.checkOnly = true;
    else if (argument === "--no-open") options.noOpen = true;
    else if (argument === "--ready-file") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--ready-file 后必须指定文件路径");
      options.readyFile = value;
      index += 1;
    }
    else if (argument === "--help" || argument === "-h") options.help = true;
    else throw new Error(`未知参数：${argument}`);
  }

  return options;
}

export function localStartupHelp() {
  return `Deep Monkey Studio 内部运行器（用户请使用 pnpm studio）

用法：
  node scripts/start-local.mjs [--target desktop|web|services] [--skip-infra] [--no-open]
  node scripts/start-local.mjs --check [--target desktop|web|services]
  node scripts/start-local.mjs --help

目标：
  desktop  API + Web 开发服务器 + Tauri 客户端（默认）
  web      API + Web 开发服务器，并打开浏览器
  services 仅启动 API，供客户端或其它前端联调

选项：
  --check       只读检查当前必需服务；不启动进程，失败时返回非零退出码
  --skip-infra  不代启当前配置所需的 PostgreSQL / MinIO
  --no-open     Web 模式就绪后不自动打开浏览器
  -h, --help    显示帮助
`;
}

export function requiredLocalServices({ target, metadataStore, objectStore }) {
  return {
    postgres: metadataStore === "postgres",
    minio: objectStore === "minio",
    api: true,
    web: target !== "services",
  };
}

export function localHealthSummary({ target, metadataStore, objectStore, postgres, minio, api, web }) {
  const required = requiredLocalServices({ target, metadataStore, objectStore });
  const services = { postgres, minio, api, web };
  return {
    target,
    healthy: Object.entries(required).every(([name, needed]) => !needed || services[name]),
    required,
    ...services,
  };
}

export function isBimStudioApiHealth(value) {
  return value?.status === "ok" && value?.service === "bim-studio-api";
}

export function isBimStudioWebDocument(value) {
  return typeof value === "string" && /<title>\s*Deep Monkey Studio\s*<\/title>/i.test(value) && /<div\s+id=["']root["']><\/div>/i.test(value);
}
