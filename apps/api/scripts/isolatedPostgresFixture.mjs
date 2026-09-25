import { spawn } from "node:child_process";
import { mkdir, mkdtemp } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createServer, connect } from "node:net";
import { delimiter, resolve } from "node:path";
import { createRequire } from "node:module";
const { Client } = createRequire(new URL("../package.json", import.meta.url))("pg");
export function postgresFixtureTools() {
  const suffix = process.platform === "win32" ? ".exe" : "";
  const directories = process.env.BIM_WRITEBACK_PG_BIN ? [process.env.BIM_WRITEBACK_PG_BIN]
    : [...(process.platform === "win32" ? ["C:/Program Files/PostgreSQL/18/bin"] : []), ...(process.env.PATH ?? "").split(delimiter).filter(Boolean)];
  const bin = directories.find(directory => ["initdb", "pg_ctl", "postgres"].every(name => existsSync(resolve(directory, `${name}${suffix}`))));
  return bin ? { initdb: resolve(bin, `initdb${suffix}`), pg_ctl: resolve(bin, `pg_ctl${suffix}`) } : undefined;
}
export const missingPostgresFixtureMessage = "隔离 PostgreSQL 测试需要 initdb / pg_ctl / postgres；请加入 PATH 或设置 BIM_WRITEBACK_PG_BIN。不会回退到正常数据库。";

const run = (file, args) => new Promise((done, reject) => {
  const child = spawn(file, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", chunk => { output += chunk; }); child.stderr.on("data", chunk => { output += chunk; });
  child.on("error", reject); child.on("exit", code => code === 0 ? done(output) : reject(new Error(`${file}: ${code}\n${output}`)));
});
async function reservePort() {
  const server = createServer(); await new Promise(done => server.listen(0, "127.0.0.1", done));
  const port = server.address().port; await new Promise(done => server.close(done)); return port;
}
/** 自建临时 cluster；不连接或修改正常 PostgreSQL、平台元数据与 .env。 */
export async function createIsolatedPostgres() {
  const executables = postgresFixtureTools();
  if (!executables) throw new Error(missingPostgresFixtureMessage);
  const parent = resolve(import.meta.dirname, "../../../test-output/runs/2026-09-05"); await mkdir(parent, { recursive: true });
  const output = await mkdtemp(resolve(parent, "postgres-writeback-"));
  const cluster = resolve(output, "cluster"), port = await reservePort();
  await run(executables.initdb, ["-D", cluster, "-U", "writeback_test", "-A", "trust", "--encoding=UTF8", "--no-locale"]);
  await run(executables.pg_ctl, ["-D", cluster, "-l", resolve(output, "postgres.log"), "-o", `-p ${port} -h 127.0.0.1`, "-w", "start"]);
  const connection = { host: "127.0.0.1", port, database: "postgres", user: "writeback_test", password: "" };
  const client = new Client(connection); await client.connect();
  let disconnectCommit = false, droppedCommits = 0;
  const sockets = new Set();
  const proxy = createServer(downstream => {
    const upstream = connect({ host: "127.0.0.1", port }); sockets.add(upstream); sockets.add(downstream);
    let tail = Buffer.alloc(0), serverBuffer = Buffer.alloc(0), armed = false;
    const close = () => { upstream.destroy(); downstream.destroy(); sockets.delete(upstream); sockets.delete(downstream); };
    downstream.on("error", close); upstream.on("error", close); downstream.on("close", close); upstream.on("close", close);
    downstream.on("data", chunk => {
      tail = Buffer.concat([tail, chunk]);
      if (disconnectCommit && tail.includes(Buffer.from("COMMIT\0"))) { armed = true; disconnectCommit = false; }
      tail = tail.subarray(Math.max(0, tail.length - 32)); upstream.write(chunk);
    });
    upstream.on("data", chunk => {
      // psql 的 SSL/GSS 探测返回单字节，不属于后续带长度的服务端消息帧。
      if (!serverBuffer.length && chunk.length === 1 && [78, 83].includes(chunk[0])) { downstream.write(chunk); return; }
      serverBuffer = Buffer.concat([serverBuffer, chunk]);
      while (serverBuffer.length >= 5) {
        const size = serverBuffer.readUInt32BE(1) + 1;
        if (serverBuffer.length < size) break;
        const frame = serverBuffer.subarray(0, size); serverBuffer = serverBuffer.subarray(size);
        if (armed && frame[0] === 67 && frame.subarray(5).toString() === "COMMIT\0") { droppedCommits++; close(); return; }
        downstream.write(frame);
      }
    });
  });
  await new Promise(done => proxy.listen(0, "127.0.0.1", done));
  return { output, connection, proxyPort: proxy.address().port, client,
    dropNextCommit() { disconnectCommit = true; }, droppedCommits: () => droppedCommits,
    async close() {
      for (const socket of sockets) socket.destroy(); await new Promise(done => proxy.close(done));
      await client.end(); await run(executables.pg_ctl, ["-D", cluster, "-m", "fast", "-w", "stop"]);
    },
  };
}
