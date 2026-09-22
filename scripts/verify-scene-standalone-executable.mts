import assert from "node:assert/strict";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { JsonStore } from "../apps/api/src/jsonStore.js";
import { LocalObjectStore } from "../apps/api/src/objects.js";
import { createApiServer } from "../apps/api/src/serverOptions.js";
import { registerSystemRoutes } from "../apps/api/src/system.js";
import { registerSceneRoutes } from "../apps/api/src/sceneRoutes.js";
import { createNativeSceneCandidateService } from "../apps/api/src/nativeSceneCandidateService.js";
import { createNativeSceneWindowVerifier } from "../apps/api/src/nativeSceneWindowVerifier.js";
import { captureNativePlayerWindow } from "./lib/dashboardNativeWindowCapture.mjs";

const [executableArg, outputArg, ...flags] = process.argv.slice(2);
const resume = flags.includes("--resume") ? "--resume" : undefined;
const background = flags.find(flag => flag.startsWith("--background="))?.slice("--background=".length);
const spotShadow = flags.includes("--spot-shadow");
const pointShadow = flags.includes("--point-shadow");
const hdrFile=flags.find(flag=>flag.startsWith("--hdr="))?.slice(6);
const largeOrigin = flags.includes("--large-origin");
const multiLight = spotShadow || pointShadow || flags.includes("--multi-light");
const directional = !!hdrFile || multiLight || flags.includes("--directional");
assert(!directional || background, "Directional profile requires an authored solid background");
assert(!background || /^#[0-9a-f]{6}$/i.test(background), "Expected #RRGGBB background");
assert(executableArg && outputArg, "Expected <native.exe> <new evidence directory>");
const output = path.resolve(outputArg); if (resume !== "--resume") await mkdir(output);
const executable = path.join(output, "verified-player.exe"); if (resume !== "--resume") await copyFile(path.resolve(executableArg), executable);
const dataDir = path.join(output, "data"), store = new JsonStore(dataDir); await store.init();
const objects = new LocalObjectStore(dataDir), at = new Date().toISOString();
const scene = { schemaVersion: 1 as const, id: "standalone-scene", projectId: "default", name: "Scene EXE 验证",
  models: [], primitives: [{ modelId: "box", name: "Box", kind: "box" as const, visible: true, opacity: 1, color: "#60a5fa",
    transform: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } } }], measurements: [],
  camera: { mode: "orbit" as const, position: { x: 3, y: 2, z: 5 }, target: { x: 0, y: 0, z: 0 } }, createdAt: at, updatedAt: at };
if (background) Object.assign(scene, { environment: { skybox: "none", gridVisible: false, backgroundColor: background } });
if (spotShadow || pointShadow || hdrFile) scene.primitives.push({ modelId:"floor",name:"Ground",kind:"box",visible:true,opacity:1,color:"#a7b2b8",
  transform:{position:{x:0,y:-1.15,z:0},rotation:{x:0,y:0,z:0},scale:{x:6,y:.1,z:6}} });
if (directional) Object.assign(scene, { lighting: { enabled: true, intensity: 1, shadowsEnabled: true,
  reflectionsEnabled: !!hdrFile, globalIlluminationEnabled: false,
  lights: [{ id: "sun", name: "Sun", type: "directional", enabled: true, color: "#ffffff", intensity: 3,
    position: { x: 3, y: 6, z: 5 }, target: { x: 0, y: 0, z: 0 }, castShadow: true },
    ...(multiLight ? [
      { id: "point", name: "Warm fill", type: "point", enabled: true, color: "#ff8050", intensity: 12, castShadow: pointShadow,
        position: { x: -2, y: 1, z: 2 }, distance: 8, decay: 2 },
      { id: "spot", name: "Cool rim", type: "spot", enabled: true, color: "#5080ff", intensity: 16, castShadow: spotShadow,
        position: { x: 0, y: 3, z: -2 }, target: { x: 0, y: 0, z: 0 }, distance: 10, decay: 2, angle: Math.PI/4, penumbra: .5 },
    ] : [])] } });
if (largeOrigin) {
  const shift = (point:{x:number;y:number;z:number}) => { point.x+=100000;point.y+=200000;point.z-=300000; };
  shift(scene.camera.position);shift(scene.camera.target);
  for (const primitive of scene.primitives) shift(primitive.transform.position);
  const lighting = (scene as typeof scene & {lighting?:{lights:Array<{position:{x:number;y:number;z:number};target?:{x:number;y:number;z:number}}>}}).lighting;
  for (const light of lighting?.lights ?? []) { shift(light.position);if(light.target)shift(light.target); }
}
if (hdrFile) {
  const sourceDirectory=path.join(dataDir,"projects/default/environments"); await mkdir(sourceDirectory,{recursive:true});
  await copyFile(path.resolve(hdrFile),path.join(sourceDirectory,"studio.hdr"));
  await store.saveAsset("default",{id:"hdr-studio",projectId:"default",kind:"environment",name:"Studio Small 09",fileName:"studio.hdr",mimeType:"image/vnd.radiance",size:(await readFile(hdrFile)).length,url:"/assets/projects/default/environments/studio.hdr",createdAt:at,updatedAt:at});
  Object.assign(scene,{environment:{skybox:"none",gridVisible:false,backgroundColor:background,environmentMapUrl:"/assets/projects/default/environments/studio.hdr",environmentAsBackground:false,environmentIntensity:1}});
}
if (resume !== "--resume") await store.saveScene(scene);
const verify = createNativeSceneWindowVerifier({ nativeExecutable: executable, frames: 12 });
const previews: Awaited<ReturnType<typeof captureNativePlayerWindow>>[] = [];
const nativeCandidates = createNativeSceneCandidateService({ store, objects, dataDir, nativeExecutable:executable, verifyWindow: async (file, signal) => {
  const evidence = await verify(file, signal); await writeFile(path.join(output, "candidate-window.json"), JSON.stringify(evidence, null, 2));
  if (background) {
    const snapshot = path.join(output, "authored-runtime.json"); await copyFile(file, snapshot);
    for (const round of [1, 2]) previews.push(await captureNativePlayerWindow({ label: `before-publication-${round}`,
      executable, args: ["--package", snapshot], env: undefined, outputDirectory: output,
      presentedMarker: "native package recovery checkpoint committed after present", timeoutMs: 60_000 }));
  }
  return evidence;
} });
const app = createApiServer(), artifacts: Array<{ kind: string; file: string; sha256: string; artifactSha256: string }> = [];
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
try {
  await registerSystemRoutes(app, store, dataDir);
  await registerSceneRoutes(app, { store, deliveryStorage: { objects, dataDir }, nativeCandidates, nativeExecutable: executable });
  const origin = await app.listen({ host: "127.0.0.1", port: 0 }); let token = "";
  const request = async (url: string, body: unknown) => {
    const result = await fetch(origin + url, { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
    assert(result.ok, `${result.status} ${await result.clone().text()}`); return result;
  };
  const login = await (await request("/api/auth/login", { username: "admin", password: "admin" })).json() as { token: string };
  assert.equal(typeof login.token, "string"); token = login.token;
  const base = "/api/projects/default/scenes/standalone-scene";
  let publication;
  if (resume === "--resume") publication = JSON.parse(await readFile(path.join(output, "publication.json"), "utf8"));
  else {
    const candidate = await (await request(`${base}/native-candidates`, { expectedSnapshot: scene })).json() as { status: string; candidateId: string };
    assert.equal(candidate.status, "ready"); assert.equal(typeof candidate.candidateId, "string");
    publication = await (await request(`${base}/publish`, { expectedSnapshot: scene, clientTarget: "deep-native", nativeCandidateId: candidate.candidateId })).json();
  }
  const record = store.getScenePublicationDependencies("default", scene.id, publication.version)!;
  await writeFile(path.join(output, "publication.json"), JSON.stringify(publication, null, 2));
  await writeFile(path.join(output, "dependencies.json"), JSON.stringify(record, null, 2));
  const icon = await readFile(new URL("../apps/web/public/brand/app-icon-chroma.png", import.meta.url));
  for (const kind of ["default", "custom"]) {
    const response = await request(`${base}/publications/${publication.version}/native-executable`, kind === "default" ? {} : {
      branding: { applicationName: "热电园区三维客户端", iconDataUrl: `data:image/png;base64,${icon.toString("base64")}` } });
    const bytes = Buffer.from(await response.arrayBuffer()), footer = bytes.subarray(-48);
    assert.equal(footer.subarray(0, 8).toString(), "DMDASH01");
    const artifact = bytes.subarray(bytes.length - 48 - Number(footer.readBigUInt64LE(8)), -48);
    assert.equal(sha(artifact), record.nativeCompiled!.runtimePackage.sha256);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    const file = path.join(output, `${kind}.exe`); await writeFile(file, bytes);
    artifacts.push({ kind, file, sha256: sha(bytes), artifactSha256: sha(artifact) });
  }
} finally { await app.close(); }
// Server is stopped; launch only the downloaded EXE with no CLI arguments or sidecar package.
const captures = [];
for (const artifact of artifacts) for (const round of [1, 2]) {
  captures.push(await captureNativePlayerWindow({ label: `${artifact.kind}-${round}`, executable: artifact.file, args: [],
    env: { ...process.env, LOCALAPPDATA: path.join(output, `local-${artifact.kind}`) }, outputDirectory: output,
    presentedMarker: "native package recovery checkpoint committed after present", timeoutMs: 60_000 }));
}
await writeFile(path.join(output, "evidence.json"), JSON.stringify({ artifacts, captures, previews, background, directional, multiLight, spotShadow, pointShadow, hdrFile, largeOrigin,
  nativeExecutableSha256: sha(await readFile(executable)), offline: "API stopped, no arguments, no runtime sidecar" }, null, 2));
await promisify(execFile)(process.execPath, [fileURLToPath(new URL("./verify-scene-standalone-captures.mjs", import.meta.url)), path.join(output, "evidence.json")]);
console.log(JSON.stringify({ output, captures: captures.length }));
