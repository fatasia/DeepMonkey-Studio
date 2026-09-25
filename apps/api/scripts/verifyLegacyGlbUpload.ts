import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import multipart from "@fastify/multipart";
import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import draco3d from "draco3dgltf";
import { MeshoptDecoder } from "meshoptimizer";
import type { ModelRecord } from "@bim-studio/contracts";
import { loadConfig } from "../src/config.js";
import { ConversionQueue } from "../src/conversion.js";
import { JsonStore } from "../src/jsonStore.js";
import { registerModelAssetRoutes } from "../src/modelAssetRoutes.js";
import { LocalObjectStore } from "../src/objects.js";
import { createApiServer } from "../src/serverOptions.js";
import { auditGlbGeometry } from "../src/converterOutputAudit.js";

const root = fileURLToPath(new URL("../../../", import.meta.url)), parent = path.join(root, "test-output/runs/2026-09-05");
await mkdir(parent, { recursive: true }); const output = await mkdtemp(path.join(parent, "api-legacy-glb-"));
const dataDir = path.join(output, "data"), store = new JsonStore(dataDir); await store.init();
const objects = new LocalObjectStore(dataDir), config = loadConfig(); config.dataDir = dataDir;
const queue = new ConversionQueue(store, config, objects), app = createApiServer();
await app.register(multipart, { limits: { fileSize: 128 * 1024 * 1024, files: 1 } });
await registerModelAssetRoutes(app, { store, queue, objects, dataDir, config });
const uids = ["06cec0c0510f4e668ea337dc50c7202c", "07f04ecaf89642dbad604c469e4dada9", "0819b51c59c3407cb98f0e2c75029e30"];
const sources = uids.map(uid => path.join(root, `data/external-assets/source-b/models/${uid}.glb`));
// 可显式传入真实 Web 下载的派生 GLB；不在脚本内重造一份冒充 Web 产物。
const inputs = [...sources, ...process.argv.slice(2).map(file => path.resolve(file))];
const report: { boundary: string; cases: Record<string, unknown>[] } = { boundary: "Fastify inject真实上传路由/ConversionQueue/隔离JsonStore与LocalObjectStore，不启动普通服务、不写原资源；不含浏览器渲染", cases: [] };
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const json = (bytes: Buffer) => JSON.parse(bytes.subarray(20, 20 + bytes.readUInt32LE(12)).toString());
await MeshoptDecoder.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ "draco3d.decoder": await draco3d.createDecoderModule(), "meshopt.decoder": MeshoptDecoder });
console.log(JSON.stringify({ output }));
try {
  for (const sourcePath of inputs) {
    const bytes = await readFile(sourcePath), original = json(bytes), filename = path.basename(sourcePath);
    const entry: Record<string, unknown> = { sourcePath, originalHash: hash(bytes), inputBytes: bytes.length, passed: false }; report.cases.push(entry);
    const form = new FormData(); form.append("file", new Blob([new Uint8Array(bytes)], { type: "model/gltf-binary" }), filename);
    const encoded = new Response(form), start = performance.now();
    const uploaded = await app.inject({ method: "POST", url: "/api/projects/default/models", headers: { "content-type": encoded.headers.get("content-type")! }, payload: Buffer.from(await encoded.arrayBuffer()) });
    assert.equal(uploaded.statusCode, 202, uploaded.body); const id = (uploaded.json() as ModelRecord).id;
    let model = store.getProject("default")!.models.find(item => item.id === id)!;
    while (!["ready", "failed"].includes(model.status) && performance.now() - start < 120000) {
      await new Promise(resolve => setTimeout(resolve, 50)); model = store.getProject("default")!.models.find(item => item.id === id)!;
    }
    assert.equal(model.status, "ready", model.message); assert.ok(model.manifest?.geometryUrl?.endsWith("/output/geometry.glb"));
    const storedSource = path.join(dataDir, "projects/default/models", id, "source", filename);
    const geometryPath = path.join(dataDir, "projects/default/models", id, "output/geometry.glb");
    const outputBytes = await readFile(geometryPath), converted = json(outputBytes);
    assert.equal(hash(await readFile(storedSource)), hash(bytes)); assert.equal(hash(await readFile(sourcePath)), hash(bytes));
    assert.ok(!converted.extensionsUsed?.includes("KHR_materials_pbrSpecularGlossiness"));
    assert.ok(!converted.extensionsRequired?.includes("KHR_materials_pbrSpecularGlossiness"));
    assert.ok(converted.materials.length > 0 && converted.materials.length <= original.materials.length); // 既有 dedup 可合并同材质。
    assert.ok(converted.materials.every((material: { pbrMetallicRoughness?: { baseColorTexture?: unknown } }) => material.pbrMetallicRoughness?.baseColorTexture));
    if (original.asset.copyright) assert.equal(converted.asset.copyright, original.asset.copyright);
    const geometry = await auditGlbGeometry(geometryPath);
    const instances = await sceneTriangles(geometryPath); assert.equal(instances, await sceneTriangles(sourcePath));
    Object.assign(entry, { passed: true, id, outputBytes: outputBytes.length, outputHash: hash(outputBytes), materials: converted.materials.length, extensions: converted.extensionsUsed, geometry, sceneTriangles: instances, milliseconds: Math.round(performance.now() - start) });
    console.log(JSON.stringify(entry));
  }
} finally { await writeFile(path.join(output, "report.json"), JSON.stringify(report, null, 2)); await app.close(); }
assert.ok(report.cases.length >= 3 && report.cases.every(entry => entry.passed));

async function sceneTriangles(file: string) {
  let triangles = 0;
  for (const scene of (await io.read(file)).getRoot().listScenes()) scene.traverse(node => {
    for (const primitive of node.getMesh()?.listPrimitives() ?? []) {
      const count = primitive.getIndices()?.getCount() ?? primitive.getAttribute("POSITION")?.getCount() ?? 0;
      triangles += primitive.getMode() === 4 ? Math.floor(count / 3) : [5, 6].includes(primitive.getMode()) ? Math.max(0, count - 2) : 0;
    }
  });
  return triangles;
}
