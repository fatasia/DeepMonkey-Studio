import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { test } from "node:test";

const execFileAsync = promisify(execFile);
const script = fileURLToPath(new URL("./start-local.mjs", import.meta.url));

test("help is read-only and rejects unknown options", async () => {
  const help = await run(["--help"]);
  assert.equal(help.exitCode, 0);
  assert.match(help.stdout, /Deep Monkey Studio 内部运行器/);
  assert.doesNotMatch(help.stdout, /Server listening|tauri dev|vite/i);

  const invalid = await run(["--unknown"]);
  assert.equal(invalid.exitCode, 1);
  assert.match(invalid.stderr, /未知参数/);
});

test("refuses an occupied API port when the listener is not Deep Monkey Studio", async () => {
  const listener = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"status":"ok","service":"another-product"}');
  });
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const address = listener.address();
  assert.ok(address && typeof address === "object");

  try {
    const result = await run(["--target", "services", "--skip-infra"], address.port);
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, new RegExp(`API 端口 ${address.port} 已被非 Deep Monkey Studio 服务占用`));
  } finally {
    listener.close();
    await once(listener, "close");
  }
});

test("check mode returns a non-zero health result without starting services", async () => {
  const listener = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/plain" });
    response.end("not Deep Monkey Studio");
  });
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const address = listener.address();
  assert.ok(address && typeof address === "object");

  try {
    const result = await run(["--check", "--target", "services"], address.port);
    assert.equal(result.exitCode, 1);
    const summary = JSON.parse(result.stdout);
    assert.equal(summary.healthy, false);
    assert.equal(summary.api, false);
    assert.equal(summary.required.api, true);
  } finally {
    listener.close();
    await once(listener, "close");
  }
});

test("remote API mode does not require this machine's PostgreSQL or MinIO", async () => {
  const listener = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"status":"ok","service":"bim-studio-api"}');
  });
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const address = listener.address();
  assert.ok(address && typeof address === "object");

  try {
    const result = await run(["--check", "--target", "services"], address.port + 1, {
      BIM_STUDIO_API_ORIGIN: `http://127.0.0.1:${address.port}`,
      METADATA_STORE: "postgres",
      OBJECT_STORE: "minio",
      POSTGRES_PORT: "43190",
      MINIO_ENDPOINT: "http://127.0.0.1:43191",
    });
    assert.equal(result.exitCode, 0);
    const summary = JSON.parse(result.stdout);
    assert.equal(summary.api, true);
    assert.equal(summary.required.postgres, false);
    assert.equal(summary.required.minio, false);
  } finally {
    listener.close();
    await once(listener, "close");
  }
});

async function run(args, apiPort = 41999, overrides = {}) {
  try {
    const result = await execFileAsync(process.execPath, [script, ...args], {
      cwd: new URL("../", import.meta.url),
      env: {
        ...process.env,
        API_PORT: String(apiPort),
        BIM_STUDIO_API_ORIGIN: `http://127.0.0.1:${apiPort}`,
        METADATA_STORE: "json",
        OBJECT_STORE: "local",
        ...overrides,
      },
      timeout: 10_000,
      windowsHide: true,
    });
    return { exitCode: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return {
      exitCode: typeof error.code === "number" ? error.code : 1,
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? String(error),
    };
  }
}
