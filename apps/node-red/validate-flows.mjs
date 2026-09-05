import { readFile } from "node:fs/promises";
import { validateFunctionLifecycle } from "./functionLifecycle.mjs";

const flows = JSON.parse(await readFile(new URL("./flows.json", import.meta.url), "utf8"));
const databaseExamples = JSON.parse(await readFile(new URL("./examples/tdengine-oracle-dashboard.json", import.meta.url), "utf8"));
const databaseCredentials = JSON.parse(await readFile(new URL("./flows_cred.example.json", import.meta.url), "utf8"));
const byId = new Map(flows.map((node) => [node.id, node]));

for (const id of [
  "scene-http-in",
  "normalize-scene-message",
  "scene-ws-listener",
  "scene-ws-out",
  "scene-http-response",
  "bim-dashboard-base",
  "bim-dashboard-page",
  "scene-dashboard-value",
  "scene-dashboard-gauge",
  "example-td-tab",
  "example-oracle-tab",
  "example-td-scene",
  "example-oracle-scene"
]) {
  if (!byId.has(id)) throw new Error(`Missing required Node-RED node: ${id}`);
}
if (byId.get("example-td-tab").disabled || byId.get("example-oracle-tab").disabled) {
  throw new Error("Database example workspaces must remain editable");
}
if (byId.get("example-td-inject").d !== true || byId.get("example-oracle-inject").d !== true) {
  throw new Error("Database example trigger nodes must remain disabled until credentials are configured");
}
for (const node of flows.filter((candidate) => candidate.z)) {
  if (!Number.isFinite(node.x) || !Number.isFinite(node.y)) {
    throw new Error(`Flow node ${node.id} is missing a canvas position`);
  }
}
const oracleServer = byId.get("example-oracle-server");
if (oracleServer.host !== "$(ORACLE_HOST)" || oracleServer.port !== "$(ORACLE_PORT)" || oracleServer.db !== "$(ORACLE_DATABASE)") {
  throw new Error("Oracle example connection must use environment variables");
}
const oracleCredentials = databaseCredentials["example-oracle-server"];
if (oracleCredentials?.user !== "$(ORACLE_USER)" || oracleCredentials?.password !== "$(ORACLE_PASSWORD)") {
  throw new Error("Oracle example credentials must use environment variables");
}
const tdengineQuery = byId.get("example-td-request");
if (tdengineQuery.outputs !== 2 || !tdengineQuery.func.includes("tdengine.sqlConnect") || !tdengineQuery.func.includes("TDENGINE_WS_URL")) {
  throw new Error("TDengine example must prefer the official WebSocket connector and provide a REST fallback");
}
for (const node of [...flows, ...databaseExamples]) validateFunctionLifecycle(node);
if (!byId.get("example-td-normalize").func.includes("body.code")) {
  throw new Error("TDengine example must handle TDengine 3.x REST error responses");
}

if (byId.get("scene-http-in").url !== "/scene") throw new Error("Scene HTTP route must remain /iot/scene");
if (byId.get("scene-ws-listener").path !== "/ws/scene") throw new Error("Scene WebSocket route must remain /iot/ws/scene");
if (byId.get("bim-dashboard-base").path !== "/dashboard") throw new Error("Dashboard must remain under /iot/dashboard");

const outputs = byId.get("normalize-scene-message").wires?.flat() ?? [];
for (const target of ["scene-ws-out", "scene-http-response", "scene-dashboard-value", "scene-dashboard-gauge"]) {
  if (!outputs.includes(target)) throw new Error(`Normalized scene messages are not wired to ${target}`);
}

console.log(`Validated ${flows.length} Node-RED nodes`);

const exampleTypes = new Set(databaseExamples.map((node) => node.type));
for (const type of ["oracledb", "oracle-server", "http request", "ui-gauge"]) {
  if (!exampleTypes.has(type)) throw new Error(`Database example is missing node type: ${type}`);
}
for (const id of ["example-td-normalize", "example-oracle-normalize"]) {
  if (!databaseExamples.some((node) => node.id === id)) throw new Error(`Database example is missing node: ${id}`);
  const builtIn = byId.get(id);
  const exported = databaseExamples.find((node) => node.id === id);
  if (builtIn.func !== exported.func) throw new Error(`Built-in database normalizer must match the exported example: ${id}`);
}
if (!byId.get("example-oracle-query").wires.flat().includes("example-oracle-normalize")) {
  throw new Error("Oracle example query must feed the normalization node");
}
const exportedTdengineQuery = databaseExamples.find((node) => node.id === "example-td-request");
if (exportedTdengineQuery?.func !== tdengineQuery.func || exportedTdengineQuery?.finalize !== tdengineQuery.finalize) {
  throw new Error("Exported TDengine example must match the built-in WebSocket flow");
}
for (const node of databaseExamples.filter((candidate) => candidate.z)) {
  if (!Number.isFinite(node.x) || !Number.isFinite(node.y)) {
    throw new Error(`Exported flow node ${node.id} is missing a canvas position`);
  }
}
for (const id of ["example-td-inject", "example-oracle-inject"]) {
  if (databaseExamples.find((node) => node.id === id)?.d !== true) {
    throw new Error(`Exported trigger node ${id} must remain disabled by default`);
  }
}
console.log(`Validated ${databaseExamples.length} TDengine/Oracle example nodes`);
