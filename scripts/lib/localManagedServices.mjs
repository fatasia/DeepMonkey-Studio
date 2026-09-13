import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export async function probeManagedService(service) {
  try {
    const response = await fetch(service.healthUrl, { headers: service.headers, signal: AbortSignal.timeout(2_000), redirect: "error" });
    if (!response.ok) return false;
    const data = await response.json();
    if (service.id === "cloud-render-worker") return data.contractVersion === 1 && typeof data.workerId === "string" && data.status === "ready";
    if (service.id === "battery-native") return data.status === "ready" && data.runtime === "rust-ort" && data.model === "battery.spm-pino";
    return Array.isArray(data.items) && typeof data.itemCount === "number";
  } catch { return false; }
}

/** 配置仅作用于本次进程树，用户的 .env 与存储拓扑不变。 */
export function localManagedServices(root, environment, { apiOrigin, webOrigin, cloudWorker = true }) {
  const media = new URL(environment.MEDIA_GATEWAY_CONTROL_URL ?? "http://127.0.0.1:9997");
  const services = [];
  if (environment.BATTERY_NATIVE_RUNTIME_MANAGED !== "false") {
    const battery = new URL(environment.BATTERY_MODEL_SERVICE_URL ?? "http://127.0.0.1:8030");
    if (Number(new URL(apiOrigin).port || 80) === Number(battery.port || 80) && battery.hostname === new URL(apiOrigin).hostname) throw new Error("API 与电池原生运行时不能使用同一个端口");
    environment.BATTERY_MODEL_SERVICE_URL = battery.origin;
    services.push({
      id: "battery-native", label: "电池 Rust ONNX", host: battery.hostname, port: Number(battery.port || 80),
      healthUrl: `${battery.origin}/health`, command: "cargo",
      args: ["run", "--manifest-path", join(root, "apps/battery-native-runtime/Cargo.toml")],
      environment: {
        ...environment,
        BATTERY_NATIVE_ADDRESS: `${battery.hostname}:${battery.port || 80}`,
        BATTERY_NATIVE_MODEL_ROOT: join(root, "apps/battery-native-runtime/models"),
      },
    });
  }
  services.push(
    {
      id: "media", label: "实时视频", host: media.hostname, port: Number(media.port || 80),
      healthUrl: `${media.origin}/v3/paths/list`,
      command: environment.MEDIA_GATEWAY_BINARY ?? join(root, `tools/mediamtx/mediamtx${process.platform === "win32" ? ".exe" : ""}`),
      args: [join(root, "tools/mediamtx/mediamtx.yml")],
      environment: { ...environment, MTX_APIADDRESS: `${media.hostname}:${media.port || 80}` },
    },
  );
  if (cloudWorker) {
    const configPath = join(root, "data/cloud-render-worker.json");
    let stored;
    if (existsSync(configPath)) {
      try { stored = JSON.parse(readFileSync(configPath, "utf8")); }
      catch { throw new Error("本地云渲染配置无法读取，请检查 data/cloud-render-worker.json"); }
    }
    const token = environment.CLOUD_RENDER_WORKER_TOKEN || stored?.token || randomBytes(24).toString("hex");
    const port = Number(environment.CLOUD_RENDER_WORKER_PORT ?? stored?.port ?? 4200);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("云渲染 Worker 端口无效");
    const worker = new URL(environment.CLOUD_RENDER_WORKER_URL ?? `http://127.0.0.1:${port}`);
    if (Number(new URL(apiOrigin).port || 80) === Number(worker.port || 80) && worker.hostname === new URL(apiOrigin).hostname) throw new Error("API 与云渲染 Worker 不能使用同一个端口");
    if (!stored?.token && !environment.CLOUD_RENDER_WORKER_TOKEN) {
      mkdirSync(dirname(configPath), { recursive: true });
      writeFileSync(configPath, `${JSON.stringify({ token, port }, null, 2)}\n`, { mode: 0o600 });
    }
    environment.CLOUD_RENDER_WORKER_URL = worker.origin;
    environment.CLOUD_RENDER_WORKER_TOKEN = token;
    // 控制面需要能加载发布页面的 Web Origin；媒体观看入口可独立落到 API 的受控代理。
    environment.CLOUD_RENDER_PUBLIC_ORIGIN ??= webOrigin ?? apiOrigin;
    services.push({
      id: "cloud-render-worker", label: "云渲染 Worker", host: worker.hostname, port: Number(worker.port || 80),
      healthUrl: `${worker.origin}/v1/health`, headers: { authorization: `Bearer ${token}` },
      command: "pnpm", args: ["--filter", "@bim-studio/cloud-render-worker", "dev"],
      environment: { ...environment, CLOUD_RENDER_HEADLESS: environment.CLOUD_RENDER_HEADLESS ?? "true", CLOUD_RENDER_WORKER_PORT: String(worker.port || 80), CLOUD_RENDER_WORKER_PUBLIC_ORIGIN: environment.CLOUD_RENDER_WORKER_PUBLIC_ORIGIN ?? apiOrigin },
    });
  }
  return services;
}

export async function ensureManagedService(service, { canConnect, start, timeoutMs = 90_000, isStopping = () => false }) {
  if (await probeManagedService(service)) return "external";
  if (!["localhost", "127.0.0.1", "::1"].includes(service.host)) throw new Error(`${service.label} 远程服务不可达，无法在本机代启`);
  if (await canConnect(service.host, service.port)) throw new Error(`${service.label} 端口 ${service.port} 已占用但健康检查失败；请检查现有服务的配置与身份`);
  start(service);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && !isStopping()) {
    if (await probeManagedService(service)) return "managed";
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error(`${service.label} 未就绪，请查看 .runtime-logs/${service.id}.err.log`);
}
