import { loadWorkerConfig } from "./config.js";
import { ChromiumRenderRuntime } from "./chromiumRuntime.js";
import { buildWorkerApp } from "./server.js";

const config = loadWorkerConfig();
const runtime = new ChromiumRenderRuntime(config);
await runtime.start();
const app = buildWorkerApp(config, runtime);
app.log.info({ health: runtime.health(0) }, "cloud render hardware probe completed");
await app.listen({ host: config.host, port: config.port });

const shutdown = async (signal: string) => {
  app.log.info({ signal }, "cloud render worker stopping");
  await app.close();
  process.exit(0);
};
process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
