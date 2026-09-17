import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import playwright from "../../cloud-render-worker/node_modules/playwright-core/index.js";
import { createProductServer } from "./onlineFlowProductServer.mjs";
import { captureProcessOutput, reservePort, waitForHealth } from "./onlineFlowAuditSupport.mjs";

/** 独立端口、独立数据目录和登录上下文；不访问正常开发 API 的业务数据。 */
export async function createIsolatedStudioGate(name, options = {}) {
  const root = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
  const parent = resolve(root, "test-output/codex-2026-09-05");
  await mkdir(parent, { recursive: true });
  const output = await mkdtemp(resolve(parent, `${name}-`));
  const apiOrigin = `http://127.0.0.1:${await reservePort()}`;
  const server = createProductServer(options.webRoot ? resolve(options.webRoot) : resolve(root, "apps/web/dist"), apiOrigin);
  await new Promise((ready) => server.listen(0, "127.0.0.1", ready));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const logs = [];
  const fixturePassword = "isolated-field-flow-admin";
  const api = spawn(process.execPath, [resolve(root, "apps/api/dist/index.js")], {
    cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, NODE_ENV: "production", API_HOST: "127.0.0.1", API_PORT: new URL(apiOrigin).port, WEB_ORIGIN: origin,
      DATA_DIR: resolve(output, "data"), METADATA_STORE: "json", OBJECT_STORE: "local", BIM_STUDIO_E2E_EPHEMERAL: "true",
      BIM_STUDIO_ADMIN_PASSWORD: fixturePassword, BIM_STUDIO_SESSION_SECRET: "isolated-local-gate-session-not-production" },
  });
  captureProcessOutput(api.stdout, logs); captureProcessOutput(api.stderr, logs);
  let client, browser;
  const close = async () => {
    await browser?.close(); await client?.dispose();
    server.closeAllConnections(); await new Promise((done) => server.close(done));
    api.kill();
    await writeFile(resolve(output, "api-log.json"), JSON.stringify(logs, null, 2));
  };
  try {
    await waitForHealth(`${apiOrigin}/health`, api);
    const response = await fetch(`${apiOrigin}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "admin", password: fixturePassword }) });
    assert.equal(response.status, 200);
    const login = await response.json();
    client = await playwright.request.newContext({ baseURL: apiOrigin, extraHTTPHeaders: { authorization: `Bearer ${login.token}` } });
    browser = await playwright.chromium.launch({ executablePath: process.env.BIM_STUDIO_CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
    const json = async (method, path, data) => {
      assert.ok(path.startsWith("/api/"));
      const result = await client.fetch(path, { method, ...(data === undefined ? {} : { data }) });
      assert.ok(result.ok(), `${method} ${path}: ${result.status()} ${await result.text()}`);
      return result.status() === 204 ? undefined : result.json();
    };
    const loginPage = async (page) => {
      await page.goto(origin);
      await page.getByLabel("用户名").fill("admin"); await page.getByLabel("密码").fill(fixturePassword);
      await page.getByRole("button", { name: "登录", exact: true }).click();
      await page.locator(".scene-manager-page").waitFor();
    };
    return { output, origin, apiOrigin, browser, client, json, loginPage, close };
  } catch (error) { await close(); throw error; }
}
