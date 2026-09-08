import assert from "node:assert/strict";
import { test } from "node:test";
import { parseStudioArguments, resolveStudioConfiguration, studioHelp } from "./studioCliArguments.mjs";

test("uses one platform-aware default without inventing a second entry", () => {
  const windows = resolveStudioConfiguration(parseStudioArguments(["start"], "win32"), undefined, "win32");
  const linux = resolveStudioConfiguration(parseStudioArguments(["start"], "linux"), undefined, "linux");
  assert.equal(windows.target, "client");
  assert.equal(linux.target, "web");
  assert.equal(linux.noOpen, true);
  assert.match(studioHelp(), /pnpm studio start/);
});

test("configures an API-only environment from the same command", () => {
  const parsed = parseStudioArguments([
    "start", "api",
    "--api-host", "127.0.0.1",
    "--api-port", "4200",
    "--metadata-store", "postgres",
    "--object-store", "minio",
    "--skip-infra",
  ], "linux");
  const configuration = resolveStudioConfiguration(parsed, undefined, "linux");
  assert.deepEqual(configuration, {
    target: "api",
    apiHost: "127.0.0.1",
    apiPort: 4200,
    apiOrigin: undefined,
    webHost: "0.0.0.0",
    webPort: 5173,
    metadataStore: "postgres",
    objectStore: "minio",
    skipInfrastructure: true,
    noOpen: true,
    https: false,
    cloudWorker: false,
  });
});

test("keeps the opt-in cloud worker across restart without touching .env", () => {
  const first = resolveStudioConfiguration(parseStudioArguments(["start", "web", "--cloud-worker"], "linux"), undefined, "linux");
  assert.equal(first.cloudWorker, true);
  const restarted = resolveStudioConfiguration(parseStudioArguments(["restart"], "linux"), first, "linux");
  assert.equal(restarted.cloudWorker, true);
  const plain = resolveStudioConfiguration(parseStudioArguments(["start", "web"], "linux"), undefined, "linux");
  assert.equal(plain.cloudWorker, false);
  assert.match(studioHelp(), /--cloud-worker/);
});

test("reuses the previous mode and explicit ports on restart", () => {
  const previous = {
    target: "web",
    apiHost: "0.0.0.0",
    apiPort: 4200,
    apiOrigin: undefined,
    webHost: "0.0.0.0",
    webPort: 5200,
    metadataStore: "json",
    objectStore: "local",
    skipInfrastructure: false,
    noOpen: true,
    https: false,
    cloudWorker: false,
  };
  const configuration = resolveStudioConfiguration(parseStudioArguments(["restart"], "linux"), previous, "linux");
  assert.deepEqual(configuration, previous);
});

test("uses current environment stores instead of a stale restart snapshot", () => {
  const previous = {
    target: "web", apiHost: "0.0.0.0", apiPort: 4100, apiOrigin: undefined,
    webHost: "0.0.0.0", webPort: 5173, metadataStore: "json", objectStore: "local", cloudWorker: false,
    skipInfrastructure: false, noOpen: true, https: false,
  };
  const result = resolveStudioConfiguration(
    parseStudioArguments(["restart", "web"], "win32"),
    previous,
    "win32",
    { METADATA_STORE: "postgres", OBJECT_STORE: "minio" },
  );
  assert.equal(result.metadataStore, "postgres");
  assert.equal(result.objectStore, "minio");
});

test("rejects unsafe or unsupported configuration instead of silently falling back", () => {
  assert.throws(() => parseStudioArguments(["start", "api", "--api-port", "70000"]), /1-65535/);
  assert.throws(() => parseStudioArguments(["start", "web", "--api-origin", "https:\/\/user:secret@example.com"]), /不含账号/);
  assert.throws(
    () => resolveStudioConfiguration(parseStudioArguments(["start", "client"], "linux"), undefined, "linux"),
    /仅支持 Windows/,
  );
  assert.throws(
    () => resolveStudioConfiguration(parseStudioArguments(["start", "client", "--https"], "win32"), undefined, "win32"),
    /暂不支持 --https/,
  );
  assert.throws(() => parseStudioArguments(["status", "--api-port", "4200"]), /只接受可选/);
});

test("keeps production deployment behind the same public entry", () => {
  const deploy = parseStudioArguments(["deploy", "--check", "--skip-build"], "linux");
  assert.equal(deploy.action, "deploy");
  assert.equal(deploy.deploymentCheck, true);
  assert.equal(deploy.skipBuild, true);
  assert.throws(() => parseStudioArguments(["undeploy", "web"], "linux"), /不支持参数/);
});
