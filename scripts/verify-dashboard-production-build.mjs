import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const usage = "node scripts/verify-dashboard-production-build.mjs <native.exe> <device-sha256>";
const [nativeExecutable, device, ...rest] = process.argv.slice(2);
if (nativeExecutable === "--help" && device === undefined) console.log(usage);
else {
  assert(nativeExecutable && path.isAbsolute(nativeExecutable) && device && /^[a-f0-9]{64}$/.test(device) && !rest.length, usage);
  // 不使用 tsx 或 development 条件，检查真实生产导出与编译后动态 bundle 位置。
  const [{ registerConfiguredDashboardNative }, { createApiServer }, { JsonStore }, { LocalObjectStore }, { loadConfig }, bundle] = await Promise.all([
    import("../apps/api/dist/dashboardNativeStartup.js"), import("../apps/api/dist/serverOptions.js"),
    import("../apps/api/dist/jsonStore.js"), import("../apps/api/dist/objects.js"), import("../apps/api/dist/config.js"),
    import("../apps/api/dist/dashboard-content-compiler/deployment.mjs"),
  ]);
  assert.equal(typeof bundle.createDashboardNativeDeployment, "function");
  const directory = await mkdtemp(path.join(tmpdir(), "dashboard-production-build-"));
  const app = createApiServer();
  try {
    const file = path.join(directory, "deployment.json");
    await writeFile(file, JSON.stringify({ nativeExecutable, expectedDeviceFingerprintSha256: device,
      configuration: { locale: "zh-CN", packageVersion: "1.0.0" } }));
    const store = new JsonStore(path.join(directory, "metadata")); await store.init();
    const runtime = await registerConfiguredDashboardNative(app, {
      store, objects: new LocalObjectStore(path.join(directory, "objects")), config: loadConfig(),
    }, file);
    assert(runtime);
    await app.ready();
    for (const endpoint of ["standalone-executable", "portable-zip", "offline-archive"]) {
      const response = await app.inject({ method: "GET", url: `/api/projects/test/applications/test/dashboard-candidates/test/${endpoint}` });
      assert.equal(response.statusCode, 401, `${endpoint} must be registered and require authentication`);
    }
    console.log(JSON.stringify({ status: "passed", productionImports: true, configuredRoutes: 3, nativeWindowTested: false }));
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
}
