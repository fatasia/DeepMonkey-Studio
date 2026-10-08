import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const require = createRequire(process.cwd() + "/apps/api/package.json");
const { NodeIO } = await import(pathToFileURL(require.resolve("@gltf-transform/core")).href);
const { ALL_EXTENSIONS } = await import(pathToFileURL(require.resolve("@gltf-transform/extensions")).href);
const { draco } = await import(pathToFileURL(require.resolve("@gltf-transform/functions")).href);
const draco3d = require("draco3dgltf");
const plain = await readFile("packages/deep-engine/lab/assets/Box.glb");
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
  "draco3d.encoder": await draco3d.createEncoderModule(), "draco3d.decoder": await draco3d.createDecoderModule(),
});
const document = await io.readBinary(plain); await document.transform(draco());
const compressed = await io.writeBinary(document);
const fixtures = [{ name: "static", bytes: plain }, { name: "textured-budget", bytes: await readFile("packages/deep-engine/lab/assets/BoxTextured.glb") },
  { name: "large-texture-budget", bytes: await largeTexturedBox() },
  { name: "draco", bytes: compressed }, { name: "live-skin-morph", bytes: liveFixture() }];
const { default: playwright } = await import("../apps/cloud-render-worker/node_modules/playwright-core/index.js");
const browser = await playwright.chromium.launch({ executablePath: process.env.SDK_GATE_CHROME ?? "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: true, args: ["--disable-gpu"] });
try {
  const page = await browser.newPage(); await page.goto("http://localhost:5173/", { waitUntil: "domcontentloaded" });
  const observed = await page.evaluate(async inputs => {
    const { decodeAuthorModel } = await import("/src/delivery/authorModelDecode.ts");
    const { normalizeStudioWasmModel } = await import("/src/viewer/normalizeStudioModel.ts");
    const { inProcessImageDecoder } = await import("/src/delivery/inProcessImageDecoder.ts");
    const { browserAuthorModelDecoder } = await import("/src/delivery/browserAuthorModelDecoder.ts");
    const sha = async bytes => [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(x => x.toString(16).padStart(2, "0")).join("");
    const plainValue = value => {
      if (ArrayBuffer.isView(value)) return { type: value.constructor.name, bytes: [...new Uint8Array(value.buffer, value.byteOffset, value.byteLength)] };
      if (Array.isArray(value)) return value.map(plainValue);
      if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, plainValue(item)]));
      return value;
    };
    const packetSha = result => sha(new TextEncoder().encode(JSON.stringify(plainValue(result.decoded))));
    const output = [];
    for (const input of inputs) {
      const bytes = Uint8Array.from(atob(input.base64), c => c.charCodeAt(0)), options = { resourcePrefix: "asset", modelId: input.name,
        maxDecodedBytes: 128 * 1024 * 1024, textureBudgetBytes: input.name.includes("texture") ? 1024 : 112 * 1024 * 1024,
        liveDeformation: true, preserveTexCoords: true };
      const baseline = await decodeAuthorModel(bytes.slice(), options, new AbortController().signal, normalizeStudioWasmModel, inProcessImageDecoder);
      const sourceBefore = await sha(bytes), tasks = [], observer = new PerformanceObserver(list => tasks.push(...list.getEntries().map(entry => entry.duration)));
      observer.observe({ type: "longtask", buffered: false }); await new Promise(resolve => setTimeout(resolve, 50)); tasks.length = 0;
      let beats = 0; const timer = setInterval(() => beats++, 10), begin = performance.now();
      const result = await browserAuthorModelDecoder(bytes, options, new AbortController().signal);
      const elapsed = performance.now() - begin; await new Promise(resolve => setTimeout(resolve, 50)); clearInterval(timer); observer.disconnect();
      output.push({ name: input.name, bytes: bytes.byteLength, sourceBefore, sourceAfter: await sha(bytes),
        baselineNormalizedSha: await sha(baseline.normalizedBytes), workerNormalizedSha: await sha(result.normalizedBytes),
        baselinePacketSha: await packetSha(baseline), workerPacketSha: await packetSha(result), mode: result.decoded.mode,
        features: result.decoded.features, textures: result.decoded.packet.textures?.map(texture => ({ width: texture.width, height: texture.height })),
        elapsed, beats, longTasks: tasks });
    }
    return output;
  }, fixtures.map(fixture => ({ name: fixture.name, base64: Buffer.from(fixture.bytes).toString("base64") })));
  await writeFile("test-output/studio-author-model-worker-browser.json", JSON.stringify(observed, null, 2));
  console.log(JSON.stringify(observed, null, 2));
  for (const result of observed) {
    assert.equal(result.sourceBefore, result.sourceAfter); assert.equal(result.baselineNormalizedSha, result.workerNormalizedSha);
    assert.equal(result.baselinePacketSha, result.workerPacketSha); assert.deepEqual(result.longTasks, []);
  }
  assert.equal(observed.at(-1).mode, "live");
  assert.deepEqual(observed.find(result => result.name === "large-texture-budget").textures, [{ width: 256, height: 128 }]);
} finally { await browser.close(); }

async function largeTexturedBox() {
  const source = await readFile("packages/deep-engine/lab/assets/BoxTextured.glb"), jsonLength = source.readUInt32LE(12);
  const json = JSON.parse(source.subarray(20, 20 + jsonLength).toString("utf8")), originalBin = source.subarray(28 + jsonLength);
  const width = 4096, height = 2048, rgba = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const index = (y * width + x) * 4;
    rgba[index] = (x * 7 + y * 13) & 255; rgba[index + 1] = (x ^ y) & 255;
    rgba[index + 2] = (x * 3 + y * 5) & 255; rgba[index + 3] = (x + y) % 3 ? 255 : 127;
  }
  const png = await require("sharp")(rgba, { raw: { width, height, channels: 4 } }).png().toBuffer();
  const offset = Math.ceil(originalBin.length / 4) * 4, bin = Buffer.alloc(Math.ceil((offset + png.length) / 4) * 4);
  originalBin.copy(bin); png.copy(bin, offset); json.buffers[0].byteLength = bin.length;
  json.images[0] = { bufferView: json.bufferViews.length, mimeType: "image/png" };
  json.bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: png.length });
  const encoded = Buffer.from(JSON.stringify(json)), padded = Buffer.alloc(Math.ceil(encoded.length / 4) * 4, 0x20); encoded.copy(padded);
  const output = Buffer.alloc(28 + padded.length + bin.length);
  output.writeUInt32LE(0x46546c67, 0); output.writeUInt32LE(2, 4); output.writeUInt32LE(output.length, 8);
  output.writeUInt32LE(padded.length, 12); output.writeUInt32LE(0x4e4f534a, 16); padded.copy(output, 20);
  output.writeUInt32LE(bin.length, 20 + padded.length); output.writeUInt32LE(0x004e4942, 24 + padded.length); bin.copy(output, 28 + padded.length);
  return output;
}

function liveFixture() {
  const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const f = values => new Uint8Array(new Float32Array(values).buffer);
  const chunks = [f([0, 0, 0, 1, 0, 0, 0, 1, 0]), new Uint8Array([0, 1, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0]),
    f([1, 0, 0, 0, .25, .75, 0, 0, .5, .5, 0, 0]), f([...identity, ...identity]), f([0, 1]),
    f([0, 0, 0, 1, 0, 0]), f([1, 0, 0, 0, 1, 0, 0, 0, 1]), f([0, 1])];
  const offsets = []; let total = 0;
  for (const bytes of chunks) { total = (total + 3) & ~3; offsets.push(total); total += bytes.length; }
  const bin = new Uint8Array((total + 3) & ~3); chunks.forEach((bytes, index) => bin.set(bytes, offsets[index]));
  const accessor = (bufferView, count, type) => ({ bufferView, componentType: 5126, count, type });
  const json = { asset: { version: "2.0" }, buffers: [{ byteLength: bin.length }],
    bufferViews: chunks.map((bytes, index) => ({ buffer: 0, byteOffset: offsets[index], byteLength: bytes.length,
      ...([0, 1, 2, 6].includes(index) ? { target: 34962 } : {}) })),
    accessors: [accessor(0, 3, "VEC3"), { bufferView: 1, componentType: 5121, count: 3, type: "VEC4" }, accessor(2, 3, "VEC4"),
      accessor(3, 2, "MAT4"), { ...accessor(4, 2, "SCALAR"), min: [0], max: [1] }, accessor(5, 2, "VEC3"), accessor(6, 3, "VEC3"), accessor(7, 2, "SCALAR")],
    nodes: [{ children: [1, 3] }, { children: [2] }, {}, { mesh: 0, skin: 0, weights: [.2] }], scenes: [{ nodes: [0] }], scene: 0,
    skins: [{ joints: [1, 2], skeleton: 1, inverseBindMatrices: 3 }],
    meshes: [{ weights: [.1], primitives: [{ attributes: { POSITION: 0, JOINTS_0: 1, WEIGHTS_0: 2 }, targets: [{ POSITION: 6 }] }] }],
    animations: [{ samplers: [{ input: 4, output: 5 }, { input: 4, output: 7 }], channels: [
      { sampler: 0, target: { node: 1, path: "translation" } }, { sampler: 1, target: { node: 3, path: "weights" } }] }] };
  const encoded = new TextEncoder().encode(JSON.stringify(json)), length = (encoded.length + 3) & ~3;
  const output = new Uint8Array(28 + length + bin.length), view = new DataView(output.buffer);
  view.setUint32(0, 0x46546c67, true); view.setUint32(4, 2, true); view.setUint32(8, output.length, true);
  view.setUint32(12, length, true); view.setUint32(16, 0x4e4f534a, true); output.fill(0x20, 20, 20 + length); output.set(encoded, 20);
  view.setUint32(20 + length, bin.length, true); view.setUint32(24 + length, 0x004e4942, true); output.set(bin, 28 + length);
  return output;
}
