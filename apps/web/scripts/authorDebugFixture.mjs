import { randomUUID } from "node:crypto";

export const debugSource = `function onStart(ctx) {
  ctx.state.frame = 0;
  const initial = 40;
  const value = addTwo(initial);
  ctx.self.update({widget: {title: "RESULT " + value}});
  ctx.log("START", value);
}
function addTwo(input) {
  const result = input + 2;
  return result;
}
function onUpdate(ctx) {
  ctx.state.frame += 1;
  ctx.state.lastElapsed = ctx.elapsedMs;
  ctx.log("FRAME", { frame: ctx.state.frame, elapsedMs: ctx.elapsedMs });
}
function onEvent(ctx) { ctx.log("EVENT"); }`;

export async function createDebugFixture(gate, theme, width, moduleSyntax = false) {
  const project = await gate.json("POST", "/api/projects", { name: `源码调试-${theme}-${width}` });
  const now = new Date().toISOString();
  const id = `debug:main-${theme}-${width}`;
  const source = (moduleSyntax ? "export " : "") + debugSource;
  const script = (scriptId, name, code) => ({ id: scriptId, name, enabled: true, apiVersion: "1.0", entrypoint: "behavior", runtime: "worker-sandbox", code, lifecycle: ["onStart", "onUpdate", "onEvent"], capabilities: ["studio.runtime", "studio.component"], permissions: ["scene.read", "scene.write"], target: { kind: "component", id: "counter" } });
  const application = await gate.json("POST", `/api/projects/${project.id}/applications`, {
    schemaVersion: 2, metadata: { id: randomUUID(), projectId: project.id, name: "源码调试工作台", revision: 1, createdAt: now, updatedAt: now },
    pages: [{ id: "page", name: "调试页", width: 720, height: 650, viewportFit: "contain", nodes: [{ id: "counter", name: "调试输出", kind: "data-widget", zIndex: 1, frame: { x: 40, y: 50, width: 620, height: 180 }, widget: { type: "text", title: "AUTHOR ORIGINAL", key: "", unit: "", fontSize: 30, textColor: "#ffffff", backgroundColor: "#11191d" } }] }],
    scenes: [], topologies: [], geo: { providerIds: [], layers: [] }, data: { connectionIds: [], datasetIds: [], transforms: [], variables: [] }, interactions: [],
    scripts: [script(id, "断点验证", source), { ...script("other", "普通脚本", "function onStart(ctx) { ctx.log('OTHER'); }"), target: { kind: "scene" } }],
    assets: [], timelines: [], publicationProfiles: [{ id: "browser", name: "浏览器", target: "browser-preview", entryPageId: "page", renderer: "auto" }],
  });
  return { project, application, source, sourceUrl: `industrial-studio-behavior-${encodeURIComponent(id)}.${moduleSyntax ? "mjs" : "js"}`, lineOffset: moduleSyntax ? 1 : 3 };
}
