// 一次性探查:在浏览器内全链编译 WASM 场景包,数包内 instances/geometries——
// 判定"两个 primitive 缺失"归属编译器(包里就缺)还是 WASM 运行时(包里有但渲染丢)。
import playwright from "../../cloud-render-worker/node_modules/playwright-core/index.js";

const webOrigin = "http://127.0.0.1:5173";
const apiOrigin = "http://127.0.0.1:4100";
const projectId = "38ea81ba-3033-4d3e-86b5-648fd58d98f1";
const sceneId = "fedab835-389b-43a5-99be-6820d0f3afde";

const login = await fetch(`${apiOrigin}/api/auth/login`, {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ username: "admin", password: "admin" }),
});
const { token } = await login.json();
const browser = await playwright.chromium.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: true, args: ["--no-sandbox"],
});
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
await context.addInitScript(({ token }) => {
  localStorage.setItem("bim-studio-auth-token", token);
  localStorage.setItem("bim-studio.renderer-backend", "webgl");
}, { token });
const page = await context.newPage();
page.setDefaultTimeout(60_000);
await page.goto(`${webOrigin}/studio/${sceneId}?project=${projectId}`, { waitUntil: "domcontentloaded" });
await page.locator(".viewport canvas:not([data-renderer-backend])").first().waitFor({ state: "visible" });
await page.waitForTimeout(1_000);

const outcome = await page.evaluate(async ({ projectId, sceneId, token }) => {
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const sceneRes = await fetch(`/api/projects/${projectId}/scenes/${sceneId}`, { headers });
  const sceneBody = await sceneRes.json();
  const projectRes = await fetch(`/api/projects/${projectId}`, { headers });
  const projectBody = await projectRes.json();
  const scene = sceneBody.snapshot ?? sceneBody.scene ?? sceneBody;
  const project = projectBody.project ?? projectBody;
  const mod = await import("/src/viewer/studioWasmRuntimePackage.ts");
  const bytes = await mod.compileStudioWasmRuntimePackage(scene, project, new AbortController().signal);
  const text = new TextDecoder().decode(bytes);
  const json = JSON.parse(text);
  const resources = json.resources ?? [];
  const renderPacketId = (json.entrypoints?.renderPacket)
    ?? resources.find(resource => resource.kind === "render-packet")?.id;
  const value = json.payloads?.[renderPacketId] ?? {};
  return {
    sceneModels: (scene.models ?? []).map(model => ({ id: model.modelId, kind: model.kind ?? "model", visible: model.visible })),
    scenePrimitives: (scene.primitives ?? []).map(model => ({ id: model.modelId, kind: model.kind ?? "primitive", visible: model.visible })),
    resourceKinds: resources.map(resource => resource.kind),
    instanceCount: (value.instances ?? []).length,
    geometryCount: (value.geometries ?? []).length,
    instanceIds: (value.instances ?? []).map(instance => instance.id),
    instanceGeometry: (value.instances ?? []).map(instance => instance.geometry),
  };
}, { projectId, sceneId, token });
console.log(JSON.stringify(outcome, null, 1));
await browser.close();
