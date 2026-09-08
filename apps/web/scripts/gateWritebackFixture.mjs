import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createIsolatedStudioGate } from "./isolatedStudioGate.mjs";

/** 仅此隔离门禁进程注入随机端口白名单，不改 .env 或正常开发 API。 */
export async function createWritebackGate() {
  const records = new Map(), writes = new Map(), disconnects = new Set();
  const server = createServer((request, response) => {
    const url = new URL(request.url, "http://fixture");
    response.setHeader("content-type", "application/json");
    if (url.pathname === "/list") {
      const row = records.get(url.searchParams.get("id"));
      response.end(JSON.stringify({ items: row ? [{ id: url.searchParams.get("id"), ...row.values }] : [] })); return;
    }
    const id = decodeURIComponent(url.pathname.slice("/records/".length));
    const record = url.pathname.startsWith("/records/") ? records.get(id) : undefined;
    if (!record) { response.writeHead(404); response.end("{}"); return; }
    if (request.method === "GET") {
      response.setHeader("etag", `"v${record.version}"`); response.end(JSON.stringify(record.values)); return;
    }
    if (request.method !== "PATCH") { response.writeHead(405); response.end("{}"); return; }
    if (request.headers["if-match"] !== `"v${record.version}"`) { response.writeHead(412); response.end("{}"); return; }
    const chunks = [];
    request.on("data", chunk => chunks.push(chunk));
    request.on("end", () => {
      try {
        const values = JSON.parse(Buffer.concat(chunks).toString());
        assert.equal(typeof values.output, "number"); assert.ok(values.output >= 0 && values.output <= 100);
        writes.set(id, (writes.get(id) ?? 0) + 1);
        record.values = { ...record.values, ...values }; record.version++;
        if (disconnects.delete(id)) { response.destroy(); return; }
        response.setHeader("etag", `"v${record.version}"`); response.end(JSON.stringify(record.values));
      } catch { response.writeHead(422); response.end("{}"); }
    });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const fixtureOrigin = `http://127.0.0.1:${server.address().port}`;
  const overrides = { DIRECT_BINDING_ALLOW_PRIVATE_NETWORK: "true", DIRECT_BINDING_ALLOWED_HOSTNAMES: "127.0.0.1", DIRECT_BINDING_ALLOWED_PORTS: String(server.address().port), DIRECT_BINDING_TIMEOUT_MS: "1500" };
  const previous = Object.fromEntries(Object.keys(overrides).map(key => [key, process.env[key]]));
  let gate;
  try { Object.assign(process.env, overrides); gate = await createIsolatedStudioGate("dataset-writeback"); }
  catch (error) { await new Promise(resolve => server.close(resolve)); throw error; }
  finally { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
  return { ...gate, fixtureOrigin,
    seed(id) { records.set(id, { version: 1, values: { output: 7 } }); writes.set(id, 0); },
    externalUpdate(id, output) { const record = records.get(id); record.version++; record.values.output = output; },
    disconnectNext(id) { disconnects.add(id); },
    record(id) { return structuredClone(records.get(id)); },
    writes(id) { return writes.get(id) ?? 0; },
    async close() { await gate.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  };
}
