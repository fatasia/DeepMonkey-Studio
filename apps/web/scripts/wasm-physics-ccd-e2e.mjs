import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildDeepRuntimePackage, serializeDeepRuntimePackage } from "@bim-studio/deep-engine/runtime-package";
import pw from "../../../node_modules/.pnpm/playwright-core@1.62.1/node_modules/playwright-core/index.js";

const out = resolve("test-output/t17-wasm-ccd");
mkdirSync(out, { recursive: true });
const basePackage = JSON.parse(readFileSync(resolve("packages/deep-engine-native/tests/fixtures/runtime-package-v1.json"), "utf8"));
const cameraPackage = JSON.parse(readFileSync(resolve("packages/deep-engine-native/tests/fixtures/runtime-package-camera-v3.json"), "utf8"));
const render = structuredClone(basePackage.payloads[basePackage.entrypoints.renderPacket]);
delete render.schema;
delete render.version;
for (const geometry of render.geometries) {
  geometry.vertices = new Float32Array(geometry.vertices);
  geometry.indices = new Uint32Array(geometry.indices);
  if (geometry.uv0) geometry.uv0 = new Float32Array(geometry.uv0);
}
const box = render.instances[0];
const instance = (id, sx, sy, sz, x) => ({ ...box, id,
  transform: [sx, 0, 0, 0, 0, sy, 0, 0, 0, 0, sz, 0, x, 0, 0, 1] });
// The tracked cube spans [-0.8, 0.8], so these scales produce 10 cm and 2 cm thickness.
render.instances = [instance("projectile-instance", 0.0625, 0.0625, 0.0625, -0.6),
  instance("wall-instance", 0.0125, 1, 1, 0)];
const dynamic = {
  schema: "deep-engine.dynamic-runtime", schemaVersion: 3, id: "scene.dynamic", revision: 1,
  physics: { schema: "deep-engine.physics-runtime", schemaVersion: 1, enabled: true,
    playing: true, gravity: [0, 0, 0], bodies: [
      { id: "projectile", type: "dynamic", initialPose: { translation: [-0.6, 0, 0], rotation: [0, 0, 0, 1] },
        initialLinearVelocity: [80, 0, 0], mass: 1, friction: 0, restitution: 0,
        collider: { kind: "render-bounds", instanceIds: ["projectile-instance"] } },
      { id: "wall", type: "fixed", initialPose: { translation: [0, 0, 0], rotation: [0, 0, 0, 1] },
        mass: 1, friction: 0, restitution: 0, collider: { kind: "render-bounds", instanceIds: ["wall-instance"] } },
    ], joints: [] },
};
const runtimePackage = buildDeepRuntimePackage({
  packageId: "scene.t17-wasm-ccd", packageVersion: "1.0.0",
  renderPacket: { id: "scene.main", revision: 1, value: render },
  camera: cameraPackage.payloads[cameraPackage.entrypoints.camera],
  environment: basePackage.payloads[basePackage.entrypoints.environment],
  dynamicRuntime: { id: dynamic.id, revision: dynamic.revision, value: dynamic },
});
const bytes = serializeDeepRuntimePackage(runtimePackage);
const fixturePath = resolve(out, "runtime-package.json");
writeFileSync(fixturePath, bytes);
const fixtureUrl = `/@fs/${fixturePath.replaceAll("\\", "/")}`;
const browser = await pw.chromium.launch({ headless: true,
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  args: ["--enable-unsafe-webgpu", "--enable-features=Vulkan", "--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
const messages = [];
page.on("pageerror", error => errors.push(error.message));
page.on("console", message => { messages.push({ type: message.type(), text: message.text() }); if (message.type() === "error") errors.push(message.text()); });
let result;
try {
  const url = new URL("/dev/engine.html?canvas=page", process.env.WASM_ENGINE_URL ?? "http://localhost:5177");
  url.searchParams.set("pkg", fixtureUrl);
  await page.goto(url.toString(), { waitUntil: "load" });
  await page.waitForFunction(() => globalThis.__engineGlueReady === true, undefined, { timeout: 10_000 });
  await page.evaluate(() => globalThis.__engineGlue.start());
  await page.waitForFunction(() => globalThis.__engineGlue?.running === true, undefined, { timeout: 30_000 });
  await page.waitForFunction(async () => (await import("/engine-wasm/deep_engine_wasm.js")).viewer_ready_generation() > 0,
    undefined, { timeout: 30_000 });
  const loaded = await page.evaluate(() => globalThis.__engineGlue.package);
  if (loaded.url !== fixtureUrl || loaded.packageId !== runtimePackage.packageId || !loaded.hashCanonical?.matches) {
    throw new Error(`Wrong runtime package loaded: ${JSON.stringify(loaded)}`);
  }
  let pose;
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      pose = await bounded(page.evaluate(() => globalThis.__engineGlue.physicsPose("projectile-instance")), 3_000);
      if (pose.fixedStep >= 1) break;
    } catch { /* GPU stage is still pending; the next query observes its committed packet. */ }
    await page.waitForTimeout(100);
  }
  if (!pose || pose.fixedStep < 1) throw new Error(`WASM physics never committed a fixed step: ${JSON.stringify({ pose, messages, errors })}`);
  const missingRejected = await page.evaluate(async () => {
    try { await globalThis.__engineGlue.physicsPose("wall-instance"); return false; }
    catch { return true; }
  });
  const screenshot = await page.screenshot({ path: resolve(out, "browser-ccd.png") });
  result = { packageId: loaded.packageId, packageHash: runtimePackage.packageHash.value,
    fixtureSha256: createHash("sha256").update(bytes).digest("hex"),
    pose, wallQueryRejected: missingRejected, screenshotSha256: createHash("sha256").update(screenshot).digest("hex"), errors, messages };
  if (pose.instanceId !== "projectile-instance" || pose.fixedStep < 1 || pose.translation[0] > -0.05
    || !missingRejected || errors.length) throw new Error(`CCD browser assertion failed: ${JSON.stringify(result)}`);
} catch (error) {
  writeFileSync(resolve(out, "browser-failure.json"), JSON.stringify({ error: String(error), result, messages, errors }, null, 2));
  throw error;
} finally {
  if (result) writeFileSync(resolve(out, "browser-e2e.json"), JSON.stringify(result, null, 2));
  await bounded(browser.close(), 5_000).catch(() => undefined);
}
console.log(JSON.stringify(result));

function bounded(promise, milliseconds) {
  return Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error("browser operation timed out")), milliseconds))]);
}
