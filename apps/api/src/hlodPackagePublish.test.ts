import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { afterAll, describe, expect, it } from "vitest";
import JSZip from "jszip";
import { Accessor, Document, NodeIO } from "@gltf-transform/core";
import { validateDeepAssetPackage } from "@bim-studio/deep-engine";
import { decodeHlodProxyGeometries } from "@bim-studio/deep-engine/hlod";
import { buildCadCompatibilityProfile, publishModelDeepAssetPackage } from "./deepAssetPackagePipeline.js";
import { createFileSystemDeepAssetPackageStore } from "./deepAssetPackageStore.js";
import { parseHlodPackageManifest } from "./hlodPackageManifest.js";

const zipPath = path.resolve(import.meta.dirname, "../../../data/external-assets/open-packs/factory.zip");
const sourceEntry = "Models/GLB format/machine.glb";
const expectedHash = "a39e3042bcb7789274428357383317d70e1c31906e5301c99e7d9e90ac584863";
const dirs: string[] = [];
afterAll(async () => { await Promise.all(dirs.map(dir => rm(dir, { recursive: true, force: true }))); });

async function setup() {
  const modelDir = await mkdtemp(path.join(tmpdir(), "hlod-publish-model-"));
  const storeDir = await mkdtemp(path.join(tmpdir(), "hlod-publish-store-"));
  dirs.push(modelDir, storeDir);
  const outputDir = path.join(modelDir, "output"); await mkdir(outputDir);
  const zip = await JSZip.loadAsync(await readFile(zipPath));
  const bytes = await zip.file(sourceEntry)!.async("nodebuffer");
  expect(createHash("sha256").update(bytes).digest("hex")).toBe(expectedHash);
  await writeFile(path.join(outputDir, "geometry.glb"), bytes);
    const prefix = "Models/GLB format/Textures/";
    for (const name of Object.keys(zip.files).filter(name => name.startsWith(prefix))) {
      const file = zip.file(name); if (!file || file.dir) continue;
      const destination = path.join(outputDir, "Textures", name.slice(prefix.length));
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, await file.async("nodebuffer"));
    }
  const sourcePath = path.join(modelDir, "source.step"); await writeFile(sourcePath, "source-v1");
  const store = createFileSystemDeepAssetPackageStore(storeDir, () => Promise.resolve(undefined));
  const publish = (signal?: AbortSignal) => publishModelDeepAssetPackage({ store, model: {
    id: "frozen-machine", projectId: "project", name: "machine", format: "step" }, sourcePath, modelDir,
    importer: { id: "fixture", version: "1" },
    compatibility: buildCadCompatibilityProfile("step", "fixture", "1", { hierarchy: false, properties: false }),
    includeHlod: true, ...(signal ? { signal } : {}),
  });
  return { modelDir, outputDir, sourcePath, storeDir, store, publish };
}

function resource(packageValue: Awaited<ReturnType<ReturnType<typeof createFileSystemDeepAssetPackageStore>["readActivePackage"]>>,
  id: string) {
  const found = packageValue!.packageValue.manifest.resources.find(item => item.id === id);
  expect(found, `missing ${id}`).toBeDefined(); return found!;
}

describe("T26 optional API package publication", () => {
  it("publishes real GLB HLOD binary and manifest through CAS, roundtrips and reuses the same blobs", async () => {
    const f = await setup();
    const first = await f.publish(); expect(first?.status).toBe("committed");
    const active = await f.store.readActivePackage(); expect(active?.revision).toBe(1);
    expect(validateDeepAssetPackage(active!.packageValue).valid).toBe(true);
    const manifestEntry = resource(active, "metadata:hlod-manifest");
    const proxyEntry = resource(active, "mesh:hlod-proxies");
    const manifestBytes = await readFile(path.join(f.modelDir, manifestEntry.logicalPath));
    const proxyBytes = await readFile(path.join(f.modelDir, proxyEntry.logicalPath));
    const parsed = parseHlodPackageManifest(JSON.parse(manifestBytes.toString("utf8")));
    const decoded = decodeHlodProxyGeometries(proxyBytes);
    expect(parsed.instanceCount).toBeGreaterThan(0);
    expect(decoded.map(item => item.id)).toEqual(parsed.proxies.map(item => item.geometryId));
    expect(parsed.proxyTriangleCount).toBe(decoded.reduce((sum, item) => sum + item.indices.length / 3, 0));
    expect(createHash("sha256").update(manifestBytes).digest("hex")).toBe(manifestEntry.blobHash);
    expect(createHash("sha256").update(proxyBytes).digest("hex")).toBe(proxyEntry.blobHash);
    expect(await readFile(path.join(f.storeDir, "blobs", proxyEntry.blobHash))).toEqual(proxyBytes);
    const second = await f.publish(); expect(second?.status).toBe("unchanged");
    expect((await f.store.readSnapshot()).revision).toBe(1);
    console.info(JSON.stringify({ fixture: "factory-machine", instanceCount: parsed.instanceCount,
      manifestBytes: manifestBytes.byteLength, binaryBytes: proxyBytes.byteLength,
      gzipBinaryBytes: gzipSync(proxyBytes).byteLength }));
  });
  it("publishes multi-node proxies and preserves stable node membership under a real GLB roundtrip", async () => {
    const f = await setup();
    const document = new Document(), buffer = document.createBuffer("source");
    const positions = document.createAccessor().setType(Accessor.Type.VEC3).setBuffer(buffer)
      .setArray(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]));
    const indices = document.createAccessor().setType(Accessor.Type.SCALAR).setBuffer(buffer)
      .setArray(new Uint16Array([0, 1, 2]));
    const mesh = document.createMesh("mesh").addPrimitive(document.createPrimitive()
      .setAttribute("POSITION", positions).setIndices(indices));
    const scene = document.createScene("factory");
    for (let index = 0; index < 8; index++) {
      scene.addChild(document.createNode(`node-${index}`).setTranslation([index * 2, 0, 0]).setMesh(mesh));
    }
    await writeFile(path.join(f.outputDir, "geometry.glb"), await new NodeIO().writeBinary(document));
    const result = await f.publish(); expect(result?.status).toBe("committed");
    const active = await f.store.readActivePackage();
    const manifestEntry = resource(active, "metadata:hlod-manifest");
    const binaryEntry = resource(active, "mesh:hlod-proxies");
    const manifest = parseHlodPackageManifest(JSON.parse(await readFile(path.join(f.modelDir, manifestEntry.logicalPath), "utf8")));
    const geometries = decodeHlodProxyGeometries(await readFile(path.join(f.modelDir, binaryEntry.logicalPath)));
    expect(manifest.instanceCount).toBe(8);
    expect(manifest.proxies.length).toBeGreaterThan(0);
    expect(manifest.proxies.map(proxy => proxy.geometryId)).toEqual(geometries.map(geometry => geometry.id));
    expect(manifest.nodes.filter(node => node.level === 0).flatMap(node => node.instanceIds).sort()).toEqual(
      Array.from({ length: 8 }, (_, index) => `node:${index}:node-${index}`).sort());
  });
  it("cancellation leaves the previously active revision untouched", async () => {
    const f = await setup(); await f.publish();
    await writeFile(f.sourcePath, "source-v2");
    const controller = new AbortController(); controller.abort();
    expect(await f.publish(controller.signal)).toBeUndefined();
    expect((await f.store.readSnapshot()).revision).toBe(1);
  });
  it("failed opt-in GLB bake retains the old active package instead of publishing an incomplete revision", async () => {
    const f = await setup(); await f.publish();
    const before = await f.store.readSnapshot();
    await writeFile(path.join(f.outputDir, "geometry.glb"), Buffer.from("broken GLB"));
    const result = await f.publish(); expect(result).toBeUndefined();
    expect(await f.store.readSnapshot()).toEqual(before);
  });
});
