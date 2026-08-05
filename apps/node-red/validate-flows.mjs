import { readFile } from "node:fs/promises";

const flows = JSON.parse(await readFile(new URL("./flows.json", import.meta.url), "utf8"));
const byId = new Map(flows.map((node) => [node.id, node]));

for (const id of [
  "scene-http-in",
  "normalize-scene-message",
  "scene-ws-listener",
  "scene-ws-out",
  "scene-http-response",
  "bim-dashboard-base",
  "bim-dashboard-page",
  "scene-dashboard-value"
]) {
  if (!byId.has(id)) throw new Error(`Missing required Node-RED node: ${id}`);
}

if (byId.get("scene-http-in").url !== "/scene") throw new Error("Scene HTTP route must remain /iot/scene");
if (byId.get("scene-ws-listener").path !== "/ws/scene") throw new Error("Scene WebSocket route must remain /iot/ws/scene");
if (byId.get("bim-dashboard-base").path !== "/dashboard") throw new Error("Dashboard must remain under /iot/dashboard");

const outputs = byId.get("normalize-scene-message").wires?.flat() ?? [];
for (const target of ["scene-ws-out", "scene-http-response", "scene-dashboard-value"]) {
  if (!outputs.includes(target)) throw new Error(`Normalized scene messages are not wired to ${target}`);
}

console.log(`Validated ${flows.length} Node-RED nodes`);
