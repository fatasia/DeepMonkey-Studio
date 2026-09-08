import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { DataConnectionRecord, DataDatasetRecord } from "@bim-studio/contracts";
import { DataWritebackService } from "./dataWritebackService.js";

const closers: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.all(closers.splice(0).map(close => close())); });
async function fixture(mode = "normal") {
  let version = 1;
  let writes = 0;
  let values = { output: 7, status: "open", privateField: "hidden" };
  const server = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (mode === "redirect") { response.writeHead(307, { location: "http://127.0.0.1/private" }); response.end(); return; }
    if (request.method === "PATCH") {
      writes++;
      if (mode === "race") version++;
      if (request.headers["if-match"] !== `"v${version}"`) { response.writeHead(412); response.end(); return; }
      const chunks: Buffer[] = [];
      request.on("data", chunk => chunks.push(chunk));
      request.on("end", () => {
        values = { ...values, ...JSON.parse(Buffer.concat(chunks).toString()) };
        version++;
        if (mode === "disconnect") { response.destroy(); return; }
        if (mode === "timeout") { setTimeout(() => response.end(JSON.stringify(values)), 350); return; }
        response.setHeader("etag", `"v${version}"`);
        response.end(mode === "malformed" ? "not-json" : JSON.stringify(values));
      });
    } else {
      if (mode !== "no-version") response.setHeader("etag", mode === "weak" ? 'W/"v1"' : `"v${version}"`);
      response.end(JSON.stringify(values));
    }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  closers.push(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const port = (server.address() as AddressInfo).port;
  const connection: DataConnectionRecord = { id: "http", projectId: "p", name: "REST", type: "http", enabled: true, config: { url: `http://127.0.0.1:${port}/list` }, createdAt: "now", updatedAt: "now" };
  const dataset: DataDatasetRecord = { id: "rows", projectId: "p", connectionId: "http", name: "records", fields: [], refreshSeconds: 0, createdAt: "now", updatedAt: "now", writeback: { version: 1, recordPath: "/records/{id}", fields: [{ key: "output", type: "number", required: true, min: 0, max: 100 }, { key: "status", type: "string", options: ["open", "closed"] }] } };
  const service = new DataWritebackService({ outboundPolicy: { allowPrivateNetwork: true, allowedHostnames: ["127.0.0.1"], allowedPorts: [port] }, timeoutMs: 150, maxResponseBytes: 10000 });
  return { service, connection, dataset, writes: () => writes };
}
describe("REST 业务填报", () => {
  it("真实 HTTP 条件写入后再次读取；重复旧版本不会再次写入", async () => {
    const f = await fixture();
    expect(await f.service.read(f.connection, f.dataset, "one")).toEqual({ values: { output: 7, status: "open" }, version: '"v1"' });
    const request = { expectedVersion: '"v1"', values: { output: 12, status: "closed" } };
    expect(await f.service.write(f.connection, f.dataset, "one", request)).toMatchObject({ version: '"v2"', values: { output: 12 } });
    expect(await f.service.read(f.connection, f.dataset, "one")).toMatchObject({ values: { output: 12, status: "closed" } });
    await expect(f.service.write(f.connection, f.dataset, "one", request)).rejects.toMatchObject({ statusCode: 409, outcome: "not-written" });
    expect(f.writes()).toBe(1);
  });
  it("服务端校验阻止越界和浏览器注入目标", async () => {
    const f = await fixture();
    for (const body of [{ values: { output: 101 }, expectedVersion: '"v1"' }, { values: { output: 8, admin: true }, expectedVersion: '"v1"' }]) await expect(f.service.write(f.connection, f.dataset, "one", body)).rejects.toMatchObject({ statusCode: 422 });
    await expect(f.service.write(f.connection, f.dataset, "one", { url: "http://evil", values: { output: 8 }, expectedVersion: '"v1"' })).rejects.toMatchObject({ statusCode: 400 });
    expect(f.writes()).toBe(0);
  });
  it.each(["no-version", "weak"])("没有强版本 %s 时禁止提交", async mode => {
    const f = await fixture(mode);
    await expect(f.service.write(f.connection, f.dataset, "one", { values: { output: 8 }, expectedVersion: '"v1"' })).rejects.toMatchObject({ code: "version-unsupported" });
    expect(f.writes()).toBe(0);
  });
  it("读取后发生并发更新也由上游 If-Match 拒绝", async () => {
    const f = await fixture("race");
    await expect(f.service.write(f.connection, f.dataset, "one", { values: { output: 8 }, expectedVersion: '"v1"' })).rejects.toMatchObject({ statusCode: 409 });
    expect((await f.service.read(f.connection, f.dataset, "one")).values.output).toBe(7);
  });
  it.each(["disconnect", "malformed", "timeout"])("提交后 %s 明确结果未知且没有自动重放", async mode => {
    const f = await fixture(mode);
    await expect(f.service.write(f.connection, f.dataset, "one", { values: { output: 8 }, expectedVersion: '"v1"' })).rejects.toMatchObject({ code: "write-outcome-unknown", outcome: "unknown" });
    expect(f.writes()).toBe(1);
    expect((await f.service.read(f.connection, f.dataset, "one")).values.output).toBe(8);
  });
  it("复用出站安全策略，不因为已保存连接就放行内网", async () => {
    const f = await fixture();
    await expect(new DataWritebackService({}).read(f.connection, f.dataset, "one")).rejects.toMatchObject({ code: "outbound-denied" });
    await expect(f.service.read(f.connection, { ...f.dataset, projectId: "other" }, "one")).rejects.toMatchObject({ code: "unsupported-target" });
    await expect(f.service.read(f.connection, f.dataset, "../other")).rejects.toMatchObject({ code: "invalid-record-id" });
    expect(f.writes()).toBe(0);
  });
});
