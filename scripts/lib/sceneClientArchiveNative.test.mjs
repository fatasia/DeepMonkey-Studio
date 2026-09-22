import { createSceneLocalFrame } from "../../apps/web/src/delivery/sceneLocalCoordinates.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { sceneCompilationSource } from "../../apps/web/src/delivery/sceneCompilationSource.ts";
import { compileSceneEnvironment } from "../../apps/web/src/delivery/compileSceneEnvironment.ts";
import { compileSceneHdrEnvironment } from "../../apps/web/src/delivery/compileSceneHdrEnvironment.ts";
import { validateSceneClientArchiveNative } from "./sceneClientArchiveNative.mjs";
const requireWeb = createRequire(new URL("../../apps/web/package.json", import.meta.url));
const { runtimeContentSha256, runtimePackageSha256 } = await import(pathToFileURL(requireWeb.resolve("@bim-studio/deep-engine/runtime-package")).href);
const paths = { scene: "scene.json", compilation: "native/compilation-evidence.json", report: "native/compatibility-report.json", runtime: "native/runtime-package.json" };
function fixture() {
  const bytes = readFileSync(new URL("../../packages/deep-engine-native/tests/fixtures/runtime-package-camera-v3.json", import.meta.url));
  const runtime = JSON.parse(bytes), camera = runtime.payloads[runtime.entrypoints.camera];
  const primitives = runtime.payloads[runtime.entrypoints.renderPacket].instances.map(instance => ({ modelId: instance.id, visible: true }));
  const scene = { schemaVersion: 1, id: "scene", projectId: "project", name: "Scene", primitives, models: [],
    camera: { position: camera.position, target: camera.target }, publishedAt: "2026-09-15T00:00:00Z" };
  const source = runtimeContentSha256(sceneCompilationSource(scene)), artifact = createHash("sha256").update(bytes).digest("hex");
  const compilation = { schemaVersion: 1, scope: "static-render-packet", recipe: "deep-scene-static-compile-v3",
    sourceSemanticHash: source, compileGraphHash: "a".repeat(64), targetArtifactHash: artifact,
    sourceAssets: [], objectBindings: primitives.map(value => ({ nodeId: value.modelId, instanceIds: [value.modelId] })),
    deferredSceneFields: [], deferredObjectFields: [], compiledSceneFields: [{ field: "camera", capability: "deep.scene.camera.v1", resourceId: "scene.camera" }] };
  const report = { schemaVersion: 1, target: "deep-native", sceneId: "scene", platform: "windows-x64", fixtureId: `scene-${source}`,
    contentFingerprint: source, compileGraphHash: compilation.compileGraphHash, targetArtifactHash: artifact,
    capabilityProfileVersion: "deep-scene-compiled-v1", status: "ready", items: [], evidence: [] };
  // 测试专用声明，检验内部绑定；不代表该样本实际通过窗口验证。
  for (const [capability, path, objectId = "scene"] of [["deep.scene.runtime.v1", "$"], ["deep.scene.camera.v1", "camera"],
    ...primitives.map((value, index) => ["deep.scene.static-primitives.v1", `primitives[${index}]`, value.modelId])]) {
    const id = `test-${path}`;
    report.items.push({ sceneId: "scene", objectId, capability, path, status: "supported", reason: "test", remediation: "test", evidenceIds: [id] });
    report.evidence.push({ id, capability, target: "deep-native", sourceSemanticHash: source, compileGraphHash: compilation.compileGraphHash,
      targetArtifactHash: artifact, fixtureId: report.fixtureId, platform: "windows-x64", scope: "native-window" });
  }
  const manifest = { target: "deep-native", projectId: "project", sceneId: "scene", sceneName: "Scene", publishedAt: scene.publishedAt, files: [],
    capabilities: { status: "ready" }, nativeRuntime: { kind: runtime.schema, schemaVersion: 3, packageHash: runtime.packageHash, status: "ready" } };
  const contents = new Map([[paths.runtime, bytes]]);
  for (const [path, value] of [[paths.scene, scene], ["project.json", { id: "project", models: [] }], [paths.compilation, compilation], [paths.report, report]]) contents.set(path, Buffer.from(JSON.stringify(value)));
  return { manifest, contents };
}
function mutate(f, key, change) {
  const path = paths[key] ?? key, value = JSON.parse(f.contents.get(path));
  change(value); f.contents.set(path, Buffer.from(JSON.stringify(value)));
}
test("accepts matching internal package and evidence without mutating input", () => {
  const f = fixture(), before = [...f.contents].map(([path, bytes]) => [path, bytes.toString("hex")]);
  assert.equal(validateSceneClientArchiveNative(f.manifest, f.contents), undefined);
  assert.deepEqual([...f.contents].map(([path, bytes]) => [path, bytes.toString("hex")]), before);
});

test("rejects hidden objects retaining rendered instances even with rebound source hashes", () => {
  const f = fixture();
  mutate(f, "scene", value => { value.primitives[0].visible = false; });
  const source = runtimeContentSha256(sceneCompilationSource(JSON.parse(f.contents.get(paths.scene))));
  mutate(f, "compilation", value => { value.sourceSemanticHash = source; });
  mutate(f, "report", value => {
    value.contentFingerprint = source; value.fixtureId = `scene-${source}`;
    for (const proof of value.evidence) { proof.sourceSemanticHash = source; proof.fixtureId = value.fixtureId; }
  });
  assert.throws(() => validateSceneClientArchiveNative(f.manifest, f.contents), /可见性/);
});

test("rejects model asset belonging to another project", () => {
  const f = modelFixture();
  mutate(f, "project.json", value => { value.models[0].projectId = "foreign"; });
  assert.throws(() => validateSceneClientArchiveNative(f.manifest, f.contents), /跨项目/);
});
for (const key of ["scene", "compilation", "report", "runtime"]) test(`rejects missing ${key}`, () => {
  const f = fixture(); f.contents.delete(paths[key]);
  assert.throws(() => validateSceneClientArchiveNative(f.manifest, f.contents), /缺少文件/);
});
for (const [key, change] of [
  ["scene", value => { value.id = "other"; }], ["scene", value => { value.camera.position[0]++; }],
  ["project.json", value => { value.id = "other"; }],
  ["compilation", value => { value.recipe = "deep-scene-static-compile-v2"; }],
  ["compilation", value => { value.deferredSceneFields = ["dashboard"]; }],
  ["compilation", value => { value.deferredObjectFields = [{ nodeId: "one", fields: ["behavior"] }]; }],
  ["compilation", value => { value.compiledSceneFields = []; }],
  ["compilation", value => { value.targetArtifactHash = "b".repeat(64); }],
  ["compilation", value => { value.objectBindings.pop(); }],
  ["compilation", value => { value.objectBindings[0].instanceIds = []; }],
  ["compilation", value => { value.objectBindings[0].instanceIds = ["unknown"]; }],
  ["compilation", value => { value.objectBindings[1].instanceIds = value.objectBindings[0].instanceIds; }],
  ["compilation", value => { value.sourceAssets = [{ assetId: "unknown", bytes: 1, sha256: "a".repeat(64) }]; }],
  ["report", value => { value.compileGraphHash = "b".repeat(64); }],
  ["report", value => { value.fixtureId = "other"; }],
  ["report", value => { value.platform = "linux"; }],
  ["report", value => { value.capabilityProfileVersion = "future"; }],
  ["report", value => { value.items.pop(); }],
  ["report", value => { value.items.push({ ...value.items[0], capability: "unknown", path: "unknown" }); }],
  ["report", value => { value.evidence = []; }],
  ["report", value => { value.evidence[0].scope = "static-render-packet"; }],
  ["report", value => { value.evidence.push(value.evidence[0]); }],
  ["report", value => { value.items[0].status = "degraded"; }],
  ["runtime", value => { value.packageHash.value = "b".repeat(64); }],
]) test(`rejects changed ${key}: ${change.toString()}`, () => {
  const f = fixture(); mutate(f, key, change);
  assert.throws(() => validateSceneClientArchiveNative(f.manifest, f.contents));
});
test("rejects outer package identity mismatch and malformed UTF-8", () => {
  const f = fixture(); f.manifest.nativeRuntime.packageHash.value = "b".repeat(64);
  assert.throws(() => validateSceneClientArchiveNative(f.manifest, f.contents), /packageHash/);
  const malformed = fixture(); malformed.contents.set(paths.report, Buffer.from([0xff]));
  assert.throws(() => validateSceneClientArchiveNative(malformed.manifest, malformed.contents));
});

function modelFixture() {
  const f = fixture(), scene = JSON.parse(f.contents.get(paths.scene)), report = JSON.parse(f.contents.get(paths.report));
  const moved = scene.primitives.pop(); scene.models = [{ ...moved, assetModelId: "asset" }];
  const source = runtimeContentSha256(sceneCompilationSource(scene));
  const sourceAsset = { assetId: "asset", bytes: 3, sha256: "c".repeat(64) };
  f.manifest.files = [{ path: "assets/model.glb", bytes: 3, sha256: sourceAsset.sha256 }];
  f.contents.set(paths.scene, Buffer.from(JSON.stringify(scene)));
  mutate(f, "project.json", value => { value.models = [{ id: "asset", manifest: { geometryUrl: "assets/model.glb" } }]; });
  mutate(f, "compilation", value => { value.sourceSemanticHash = source; value.sourceAssets = [sourceAsset]; });
  report.contentFingerprint = source; report.fixtureId = `scene-${source}`;
  for (const proof of report.evidence) { proof.sourceSemanticHash = source; proof.fixtureId = report.fixtureId; }
  const item = report.items.find(value => value.objectId === moved.modelId);
  item.path = "models[0]"; item.capability = "deep.scene.static-glb.v1";
  report.evidence.find(value => value.id === item.evidenceIds[0]).capability = item.capability;
  f.contents.set(paths.report, Buffer.from(JSON.stringify(report)));
  return f;
}
test("accepts uniquely mapped model source bytes and rejects inconsistent asset provenance", () => {
  const valid = modelFixture(); validateSceneClientArchiveNative(valid.manifest, valid.contents);
  for (const change of [
    f => mutate(f, "compilation", value => { value.sourceAssets = []; }),
    f => mutate(f, "compilation", value => { value.sourceAssets.push(value.sourceAssets[0]); }),
    f => mutate(f, "compilation", value => { value.sourceAssets[0].bytes++; }),
    f => mutate(f, "project.json", value => { value.models.push(value.models[0]); }),
    f => mutate(f, "project.json", value => { value.models[0].manifest.geometryUrl = "https://example.com/model.glb"; }),
    f => { f.manifest.files[0].sha256 = "d".repeat(64); },
  ]) {
    const invalid = modelFixture(); change(invalid);
    assert.throws(() => validateSceneClientArchiveNative(invalid.manifest, invalid.contents), /源资源/);
  }
});


function v4Fixture(changeScene = () => {}) {
  const f = fixture();
  const scene = JSON.parse(f.contents.get(paths.scene));
  const vector = values => ({ x: values[0] + 1000000, y: values[1], z: values[2] });
  scene.camera = { mode: "orbit", position: vector(scene.camera.position), target: vector(scene.camera.target) };
  changeScene(scene);
  f.contents.set(paths.scene, Buffer.from(JSON.stringify(scene)));
  const compilation = JSON.parse(f.contents.get(paths.compilation)), runtime = JSON.parse(f.contents.get(paths.runtime));
  compilation.recipe = "deep-scene-static-compile-v4";
  compilation.sourceSemanticHash = runtimeContentSha256(sceneCompilationSource(scene));
  compilation.localCoordinates = createSceneLocalFrame(scene); compilation.maxSourceBytes = 256 * 1024 ** 2;
  compilation.compileGraphHash = runtimeContentSha256({ recipe: compilation.recipe, sourceSemanticHash: compilation.sourceSemanticHash,
    sourceAssets: compilation.sourceAssets, packageId: runtime.packageId, packageVersion: runtime.packageVersion,
    maxSourceBytes: compilation.maxSourceBytes, localCoordinates: compilation.localCoordinates,
    cameraHash: runtime.resources.find(resource => resource.kind === "scene-camera").contentHash.value,
    renderPacketHash: runtime.resources.find(resource => resource.kind === "render-packet").contentHash.value });
  f.contents.set(paths.compilation, Buffer.from(JSON.stringify(compilation)));
  mutate(f, "report", report => {
    report.compileGraphHash = compilation.compileGraphHash; report.contentFingerprint = compilation.sourceSemanticHash; report.fixtureId = `scene-${compilation.sourceSemanticHash}`;
    for (const evidence of report.evidence) { evidence.compileGraphHash = compilation.compileGraphHash; evidence.sourceSemanticHash = compilation.sourceSemanticHash; evidence.fixtureId = report.fixtureId; }
  });
  return f;
}
test("v4 independently recomputes graph and localized camera while v3 remains accepted", () => {
  validateSceneClientArchiveNative(v4Fixture().manifest, v4Fixture().contents);
  const old = fixture(); validateSceneClientArchiveNative(old.manifest, old.contents);
});
for (const [name, change] of [
  ["origin", value => { value.localCoordinates.origin.x++; }],
  ["profile", value => { value.localCoordinates.profile.maxFloat32CoordinateError = 99; }],
  ["hash", value => { value.compileGraphHash = "b".repeat(64); }],
  ["budget", value => { value.maxSourceBytes--; }],
  ["missing frame", value => { delete value.localCoordinates; }],
]) test(`v4 rejects rebound ${name}`, () => {
  const f = v4Fixture(); mutate(f, "compilation", change);
  const graph = JSON.parse(f.contents.get(paths.compilation)).compileGraphHash;
  mutate(f, "report", report => { report.compileGraphHash = graph; report.evidence.forEach(evidence => { evidence.compileGraphHash = graph; }); });
  assert.throws(() => validateSceneClientArchiveNative(f.manifest, f.contents), /Native 包内容不一致/);
});
test("v4 rejects a camera edit even when source identity and evidence are rebound", () => {
  const f = v4Fixture(); mutate(f, "scene", scene => { scene.camera.position.x++; });
  const source = runtimeContentSha256(sceneCompilationSource(JSON.parse(f.contents.get(paths.scene))));
  mutate(f, "compilation", value => { value.sourceSemanticHash = source; });
  mutate(f, "report", value => { value.contentFingerprint = source; value.fixtureId = `scene-${source}`;
    value.evidence.forEach(evidence => { evidence.sourceSemanticHash = source; evidence.fixtureId = value.fixtureId; }); });
  assert.throws(() => validateSceneClientArchiveNative(f.manifest, f.contents), /局部相机/);
});

test("v4 accepts strict inactive fields with source and graph independently rebound", () => {
  const f = v4Fixture(scene => Object.assign(scene, {
    animation: {duration:10,loop:false,autoplay:true,camera:[],models:[]},
    clipping: {enabled:false,axis:'x',offset:0,inverted:false},
    physics: {enabled:false,playing:false,gravity:{x:0,y:-9.81,z:0}},
    coordinateSystem: {unit:'m',upAxis:'y',handedness:'right',origin:{x:0,y:0,z:0}},
  }));
  validateSceneClientArchiveNative(f.manifest,f.contents);
});
for (const [key,value] of [
  ['animation',{duration:10,loop:false,camera:[{}],models:[]}],
  ['animation',{duration:10,loop:false,camera:[],models:[],future:false}],
  ['physics',{enabled:false,playing:true,gravity:{x:0,y:0,z:0}}],
  ['coordinateSystem',{unit:'mm',upAxis:'y',handedness:'right',origin:{x:0,y:0,z:0}}],
  ['cameraConstraints',{nearClip:0.05}], ['environment',{gridVisible:true}], ['weather','rain'], ['future',[]],
]) test(`v4 refuses deleted deferred evidence for ${key}: ${JSON.stringify(value)}`, () => {
  const f=v4Fixture(scene=>{scene[key]=value;});
  // All source/graph/report bindings have been recomputed; the empty deferred list is still false.
  assert.throws(()=>validateSceneClientArchiveNative(f.manifest,f.contents),/未编译场景字段/);
});

test("v4 rejects authored clipping when the legacy camera payload has no section plane", () => {
  const f = v4Fixture(scene => { scene.clipping = { enabled: true, axis: "x", offset: 0, inverted: false }; });
  assert.throws(() => validateSceneClientArchiveNative(f.manifest, f.contents), /未编译场景字段/);
});

function rebindV5(f) {
  const runtime = JSON.parse(f.contents.get(paths.runtime));
  for (const resource of runtime.resources) resource.contentHash.value = runtimeContentSha256(runtime.payloads[resource.id]);
  runtime.packageHash.value = runtimePackageSha256(runtime);
  const bytes = Buffer.from(JSON.stringify(runtime));
  f.contents.set(paths.runtime, bytes); f.manifest.nativeRuntime.packageHash = runtime.packageHash;
  const compilation = JSON.parse(f.contents.get(paths.compilation));
  compilation.targetArtifactHash = createHash("sha256").update(bytes).digest("hex");
  compilation.compileGraphHash = runtimeContentSha256({ recipe: compilation.recipe, sourceSemanticHash: compilation.sourceSemanticHash,
    sourceAssets: compilation.sourceAssets, packageId: runtime.packageId, packageVersion: runtime.packageVersion,
    maxSourceBytes: compilation.maxSourceBytes, localCoordinates: compilation.localCoordinates,
    ...(["deep-scene-static-compile-v6", "deep-scene-static-compile-v7", "deep-scene-static-compile-v8", "deep-scene-static-compile-v9", "deep-scene-static-compile-v10", "deep-scene-static-compile-v11"].includes(compilation.recipe) ? { environmentHash: runtimeContentSha256(runtime.payloads[runtime.entrypoints.environment]) } : {}),
    ...(compilation.recipe==="deep-scene-static-compile-v11" ? {environmentSource:compilation.environmentSource} : {}),
    cameraHash: runtime.resources.find(resource => resource.kind === "scene-camera").contentHash.value,
    renderPacketHash: runtime.resources.find(resource => resource.kind === "render-packet").contentHash.value });
  f.contents.set(paths.compilation, Buffer.from(JSON.stringify(compilation)));
  mutate(f, "report", report => {
    report.compileGraphHash = compilation.compileGraphHash; report.targetArtifactHash = compilation.targetArtifactHash;
    for (const evidence of report.evidence) {
      evidence.compileGraphHash = compilation.compileGraphHash; evidence.targetArtifactHash = compilation.targetArtifactHash;
    }
  });
}
function v5Fixture() {
  const f = v4Fixture();
  mutate(f, "compilation", value => { value.recipe = "deep-scene-static-compile-v5"; });
  const frame = JSON.parse(f.contents.get(paths.compilation)).localCoordinates;
  mutate(f, "runtime", runtime => {
    const camera = runtime.payloads[runtime.entrypoints.camera]; camera.schemaVersion = 2; camera.coordinateFrame = frame;
  });
  rebindV5(f); return f;
}

function v6Fixture(lighting,hdr=false) {
  const f = v5Fixture();
  const environment = { skybox: "none", gridVisible: false, backgroundColor: "#172126" };
  const origin = createSceneLocalFrame(JSON.parse(f.contents.get(paths.scene))).origin;
  let ibl;
  if(hdr) {
    environment.environmentMapUrl="assets/studio.hdr";environment.environmentAsBackground=false;environment.environmentIntensity=1;
    const source=JSON.parse(readFileSync(new URL("../../packages/deep-engine-native/tests/fixtures/runtime-package-prefiltered-ibl-v1.json",import.meta.url)));
    ibl={...source.payloads[source.entrypoints.environment],id:"scene.environment"};
    f.contents.set("assets/studio.hdr",Buffer.from("hdr"));
    ibl.source.contentHash.value=createHash("sha256").update("hdr").digest("hex");
    f.manifest.files.push({path:"assets/studio.hdr",bytes:3,sha256:ibl.source.contentHash.value});
  }
  const payload = hdr ? compileSceneHdrEnvironment(environment,lighting,ibl,undefined,origin) : compileSceneEnvironment(environment, lighting, undefined, origin);
  const capabilityLighting = hdr ? "deep.scene.hdr-lighting.v1" : payload.schemaVersion === 5 ? "deep.scene.point-shadow.v1" : payload.schemaVersion === 4 ? "deep.scene.spot-shadow.v1" : payload.lighting?.localLights ? "deep.scene.multi-light.v1" : "deep.scene.directional-light.v1";
  mutate(f, "scene", scene => { scene.environment = environment; if (lighting) scene.lighting = lighting; });
  const source = runtimeContentSha256(sceneCompilationSource(JSON.parse(f.contents.get(paths.scene))));
  mutate(f, "compilation", value => {
    value.recipe = hdr ? "deep-scene-static-compile-v11" : payload.schemaVersion === 5 ? "deep-scene-static-compile-v10" : payload.schemaVersion === 4 ? "deep-scene-static-compile-v9" : payload.lighting?.localLights ? "deep-scene-static-compile-v8" : lighting ? "deep-scene-static-compile-v7" : "deep-scene-static-compile-v6"; value.sourceSemanticHash = source;
    if(hdr) value.environmentSource={bytes:3,sha256:ibl.source.contentHash.value};
    value.compiledSceneFields.push({ field: "environment", capability: hdr ? "deep.scene.hdr-environment.v1" : "deep.scene.solid-environment.v1", resourceId: "scene.environment" });
    if (lighting) value.compiledSceneFields.push({ field: "lighting", capability: capabilityLighting, resourceId: "scene.environment" });
  });
  mutate(f, "runtime", value => {
    const old = value.entrypoints.environment;
    delete value.payloads[old]; value.payloads[payload.id] = payload; value.entrypoints.environment = payload.id;
    value.resources.find(r => r.id === old).id = payload.id;
    value.resources.sort((a, b) => a.id < b.id ? -1 : 1);
  });
  mutate(f, "report", value => {
    value.contentFingerprint = source; value.fixtureId = `scene-${source}`;
    const capability = hdr ? "deep.scene.hdr-environment.v1" : "deep.scene.solid-environment.v1", id = "test-environment";
    value.items.push({ sceneId: "scene", objectId: "scene", path: "environment", capability, status: "supported", reason: "test", remediation: "test", evidenceIds: [id] });
    value.evidence.push({ ...value.evidence[0], id, capability });
    if (lighting) {
      value.items.push({ ...value.items.at(-1), path: "lighting", capability: capabilityLighting, evidenceIds: ["test-light"] });
      value.evidence.push({ ...value.evidence[0], id: "test-light", capability: capabilityLighting });
    }
    value.evidence.forEach(e => { e.sourceSemanticHash = source; e.fixtureId = value.fixtureId; });
  });
  rebindV5(f); return f;
}
test("v6 validates the solid environment payload against author semantics", () => {
  const f = v6Fixture(); validateSceneClientArchiveNative(f.manifest, f.contents);
});
const authorLight = { enabled: true, intensity: 1, shadowsEnabled: true, reflectionsEnabled: false, globalIlluminationEnabled: false,
  lights: [{ id: "sun", name: "Sun", type: "directional", enabled: true, color: "#ffffff", intensity: 2, castShadow: true }] };
test("v7 consumes exact directional-light source and evidence", () => {
  const f = v6Fixture(authorLight); validateSceneClientArchiveNative(f.manifest, f.contents);
});
const authorMany = { ...authorLight, lights: [...authorLight.lights,
  { id: "point", name: "Point", type: "point", enabled: true, color: "#ff0000", intensity: 4, castShadow: false,
    position: { x: 4, y: 6, z: 2 }, distance: 12, decay: 2 }] };
test("v8 consumes multi-light source including floating origin", () => {
  const f = v6Fixture(authorMany); validateSceneClientArchiveNative(f.manifest, f.contents);
});
const authorShadow = {...authorLight,lights:[...authorLight.lights,{id:"spot",name:"Spot",type:"spot",enabled:true,color:"#ffffff",intensity:4,castShadow:true,
  position:{x:0,y:4,z:3},target:{x:0,y:0,z:0},distance:12,angle:.6,penumbra:.2,decay:2}]};
test("v9 consumes exact spot shadow contract",()=>{const f=v6Fixture(authorShadow);validateSceneClientArchiveNative(f.manifest,f.contents);});
const authorPointShadow={...authorMany,lights:authorMany.lights.map(light=>({...light,castShadow:true}))};
test("v10 consumes six-face point shadow contract",()=>{const f=v6Fixture(authorPointShadow);validateSceneClientArchiveNative(f.manifest,f.contents);});
test("v10 rejects removed point projection despite rebound hashes",()=>{
  const f=v6Fixture(authorPointShadow);
  mutate(f,"runtime",v=>{v.payloads[v.entrypoints.environment].lighting.localLights[0].castShadow=false;});
  rebindV5(f); assert.throws(()=>validateSceneClientArchiveNative(f.manifest,f.contents));
});
test("v11 consumes source-bound frozen HDR and rejects rebound source substitution",()=>{
  const f=v6Fixture({...authorPointShadow,reflectionsEnabled:true},true);
  validateSceneClientArchiveNative(f.manifest,f.contents);
  mutate(f,"runtime",v=>{v.payloads[v.entrypoints.environment].ibl.source.contentHash.value="b".repeat(64);});
  rebindV5(f);assert.throws(()=>validateSceneClientArchiveNative(f.manifest,f.contents),/HDR/);
});
test("v9 rejects a removed shadow request even when every hash is rebound",()=>{
  const f=v6Fixture(authorShadow);
  mutate(f,"runtime",v=>{const env=v.payloads[v.entrypoints.environment];env.lighting.localLights[0].castShadow=false;});
  rebindV5(f);assert.throws(()=>validateSceneClientArchiveNative(f.manifest,f.contents));
});
for (const [name, patch] of [["position", p => { p.position[0] += 1; }], ["range", p => { p.range = 10; }],
  ["decay", p => { p.decay = 1; }], ["cone", p => { p.innerCos = 1; }], ["color", p => { p.radiance[1] = 1; }]]) {
  test(`v8 rejects rebound local ${name}`, () => {
    const f = v6Fixture(authorMany); mutate(f, "runtime", v => patch(v.payloads[v.entrypoints.environment].lighting.localLights[0]));
    rebindV5(f); assert.throws(() => validateSceneClientArchiveNative(f.manifest, f.contents));
  });
}
for (const [name, patch] of [["radiance", p => { p.radiance[0] = 0.3; }], ["exposure", p => { p.exposure = 1.4; }],
  ["direction", p => { p.direction = [0,0,1]; }], ["shadows", p => { p.shadows = false; }]]) {
  test(`v7 rejects rebound ${name}`, () => {
    const f = v6Fixture(authorLight); mutate(f, "runtime", v => patch(v.payloads[v.entrypoints.environment].lighting));
    rebindV5(f); assert.throws(() => validateSceneClientArchiveNative(f.manifest, f.contents));
  });
}
for (const [name, mutatePayload] of [["color", p => { p.backgroundSrgb[0] = 0.8; }],
  ["transform", p => { p.outputTransform = "aces-exposure-2"; }]]) {
  test(`v6 rejects ${name} despite rebound artifact, graph and evidence hashes`, () => {
    const f = v6Fixture(); mutate(f, "runtime", value => mutatePayload(value.payloads[value.entrypoints.environment]));
    rebindV5(f); assert.throws(() => validateSceneClientArchiveNative(f.manifest, f.contents));
  });
}
test("v6 rejects deleted environment mapping or proof", () => {
  for (const key of ["compilation", "report"]) {
    const f = v6Fixture();
    mutate(f, key, value => { if (key === "compilation") value.compiledSceneFields.pop(); else value.evidence.pop(); });
    assert.throws(() => validateSceneClientArchiveNative(f.manifest, f.contents));
  }
});
test("v5 accepts an embedded frame restoring the authored world camera", () => {
  const f = v5Fixture(); validateSceneClientArchiveNative(f.manifest, f.contents);
  const runtime = JSON.parse(f.contents.get(paths.runtime)), camera = runtime.payloads[runtime.entrypoints.camera];
  const scene = JSON.parse(f.contents.get(paths.scene));
  for (const key of ["position", "target"]) assert.deepEqual(
    camera[key].map((value, axis) => value + camera.coordinateFrame.origin[["x", "y", "z"][axis]]),
    [scene.camera[key].x, scene.camera[key].y, scene.camera[key].z]);
});
for (const [name, change] of [
  ["origin", camera => { camera.coordinateFrame.origin.x += 1000; }],
  ["missing frame", camera => { delete camera.coordinateFrame; }],
  ["schema downgrade", camera => { camera.schemaVersion = 1; delete camera.coordinateFrame; }],
  ["local position", camera => { camera.position[0]++; }],
]) test(`v5 rejects ${name} after all package and evidence hashes are rebound`, () => {
  const f = v5Fixture(); mutate(f, "runtime", runtime => change(runtime.payloads[runtime.entrypoints.camera]));
  rebindV5(f); assert.throws(() => validateSceneClientArchiveNative(f.manifest, f.contents));
});
test("v5 rejects compilation frame disagreement even with a matching graph hash", () => {
  const f = v5Fixture(); mutate(f, "compilation", value => { value.localCoordinates.origin.x++; });
  rebindV5(f); assert.throws(() => validateSceneClientArchiveNative(f.manifest, f.contents), /局部坐标原点/);
});

for (const version of [4, 5]) for (const field of ["weather", "object-data-binding"]) test(`v${version} rejects uncompiled ${field} even when source, package and evidence identities are rebound`, () => {
  const f = version === 5 ? v5Fixture() : v4Fixture();
  mutate(f, "scene", scene => {
    if (field === "weather") scene.weather = "rain";
    else scene.primitives[0].dataBinding = { source: "sim:uncompiled" };
  });
  const source = runtimeContentSha256(sceneCompilationSource(JSON.parse(f.contents.get(paths.scene))));
  mutate(f, "compilation", value => { value.sourceSemanticHash = source; });
  mutate(f, "report", report => {
    report.contentFingerprint = source; report.fixtureId = `scene-${source}`;
    for (const evidence of report.evidence) { evidence.sourceSemanticHash = source; evidence.fixtureId = report.fixtureId; }
  });
  rebindV5(f);
  assert.throws(() => validateSceneClientArchiveNative(f.manifest, f.contents), /未编译(场景|对象)字段/);
});

for (const version of [4, 5]) for (const [field, value] of [["verticalFovDegrees", 90], ["near", 1], ["far", 90000], ["revision", 2]]) {
  test(`v${version} rejects rebound complete camera ${field}`, () => {
    const f = version === 5 ? v5Fixture() : v4Fixture();
    mutate(f, "runtime", runtime => { runtime.payloads[runtime.entrypoints.camera][field] = value; });
    if (field === "revision") mutate(f, "runtime", runtime => {
      runtime.resources.find(resource => resource.kind === "scene-camera").revision = value;
    });
    rebindV5(f);
    assert.throws(() => validateSceneClientArchiveNative(f.manifest, f.contents), /完整相机参数/);
  });
}
for (const distance of [1, 2000]) test(`v5 accepts authored adaptive clipping at distance ${distance}`, () => {
  const f = v5Fixture();
  mutate(f, "scene", scene => { scene.camera.position = { ...scene.camera.target, z: scene.camera.target.z + distance }; });
  const scene = JSON.parse(f.contents.get(paths.scene));
  const source = runtimeContentSha256(sceneCompilationSource(scene));
  mutate(f, "compilation", value => { value.sourceSemanticHash = source; });
  mutate(f, "report", report => {
    report.contentFingerprint = source; report.fixtureId = `scene-${source}`;
    for (const proof of report.evidence) { proof.sourceSemanticHash = source; proof.fixtureId = report.fixtureId; }
  });
  mutate(f, "runtime", runtime => {
    const camera = runtime.payloads[runtime.entrypoints.camera];
    camera.position = camera.target.map((value, axis) => value + (axis === 2 ? distance : 0));
    camera.near = distance === 1 ? 0.01 : 0.05; camera.far = distance === 1 ? 100000 : 200000;
  });
  rebindV5(f); validateSceneClientArchiveNative(f.manifest, f.contents);
});
