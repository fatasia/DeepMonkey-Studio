import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { inspectB3dmContainer } from '../lib/industrialB3dmPreflight.mjs';
import { normalizeTilesRtc } from '../lib/industrialTilesRtc.mjs';
import { buildTilesProperties } from '../lib/industrialTilesProperties.mjs';

const root = path.resolve('data/external-assets/industrial-format-plan/build-trial/gltf-pipeline');
const require = createRequire(path.join(root, 'package.json'));
const pipeline = require('gltf-pipeline');
const { NodeIO } = createRequire(path.resolve('apps/api/package.json'))('@gltf-transform/core');
const { Matrix4, Vector3, Quaternion } = createRequire(path.resolve('apps/web/package.json'))('three');
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const fixtureRoot = path.resolve('data/external-assets/format-fixtures');
const output = path.resolve(process.argv[2] ?? 'test-output/industrial-tiles-glb2-20260918');
const manifest = JSON.parse(await readFile(path.join(fixtureRoot, 'manifest.json'), 'utf8'));
const packageInfo = require('gltf-pipeline/package.json');
assert.equal(packageInfo.version, '4.3.1');
await mkdir(output, { recursive: true });
const results = [];
for (const sample of manifest.samples.filter((item) => item.format === '3d-tiles' && item.path.endsWith('.b3dm'))) {
  const bytes = await readFile(path.join(fixtureRoot, sample.path));
  assert.equal(hash(bytes), sample.sha256);
  const inspected = inspectB3dmContainer(bytes);
  const glb1 = bytes.subarray(inspected.glbOffset, inspected.glbOffset + inspected.glbBytes);
  const jsonLength = glb1.readUInt32LE(12);
  const source = JSON.parse(glb1.toString('utf8', 20, 20 + jsonLength));
  assert.equal(inspected.glbVersion, 1);
  // 只对自包含样本运行候选库；不允许资源加载阶段读取外部路径或网络。
  for (const collection of [source.buffers, source.images, source.shaders]) {
    for (const item of Object.values(collection ?? {})) {
      assert.ok(!item.uri || item.uri === 'binary_glTF' || item.uri.startsWith('data:'), `External resource: ${item.uri}`);
    }
  }
  const options = { keepUnusedElements: true, customStages: [gltf => {
    const normalized = normalizeTilesRtc(gltf);
    if (normalized === gltf) return;
    for (const key of Object.keys(gltf)) delete gltf[key];
    Object.assign(gltf, normalized);
  }] };
  const first = await pipeline.processGlb(glb1, options);
  const second = await pipeline.processGlb(glb1, options);
  assert.equal(hash(first.glb), hash(second.glb), 'Conversion must be deterministic');
  assert.deepEqual(Object.keys(first.separateResources), []);
  assert.equal(first.glb.readUInt32LE(4), 2);
  const document = JSON.parse(first.glb.toString('utf8', 20, 20 + first.glb.readUInt32LE(12)));
  const meshes = document.meshes;
  assert.equal(document.extensions?.CESIUM_RTC, undefined);
  const decoded = await new NodeIO().readBinary(first.glb);
  const center = source.extensions.CESIUM_RTC.center;
  for (const scene of decoded.getRoot().listScenes()) {
    for (const node of scene.listChildren()) {
      assert.deepEqual(node.getTranslation(), [center[0], center[2], -center[1]]);
    }
  }
  const beforeWorld = worldVertices(source, glb1, center);
  const afterWorld = worldVertices(document, first.glb, [0, 0, 0]);
  assert.equal(afterWorld.length, beforeWorld.length);
  let worldMaxError = 0;
  for (let i = 0; i < beforeWorld.length; i++) {
    worldMaxError = Math.max(worldMaxError, ...beforeWorld[i].map((value, axis) => Math.abs(value - afterWorld[i][axis])));
  }
  assert.ok(worldMaxError <= 1e-7, `RTC world position drift: ${worldMaxError}`);
  const originalMeshes = Object.values(source.meshes);
  assert.equal(meshes.length, originalMeshes.length);
  let vertices = 0;
  let triangles = 0;
  const referencedBatchIds = [];
  for (let m = 0; m < meshes.length; m++) {
    const primitives = meshes[m].primitives;
    assert.equal(primitives.length, originalMeshes[m].primitives.length);
    for (let p = 0; p < primitives.length; p++) {
      const original = originalMeshes[m].primitives[p];
      const primitive = primitives[p];
      assert.notEqual(primitive.attributes._BATCHID, undefined, 'Missing feature identity');
      referencedBatchIds.push(...readLegacyAccessor(document, first.glb, primitive.attributes._BATCHID));
      assert.equal(primitive.mode ?? 4, original.mode ?? 4);
      for (const [semantic, accessorId] of Object.entries(original.attributes)) {
        const attribute = primitive.attributes[semantic === 'BATCHID' ? '_BATCHID' : semantic];
        assert.notEqual(attribute, undefined, `Lost attribute ${semantic}`);
        assert.deepEqual(readLegacyAccessor(document, first.glb, attribute), readLegacyAccessor(source, glb1, accessorId));
      }
      if (original.indices !== undefined) {
        assert.deepEqual(readLegacyAccessor(document, first.glb, primitive.indices), readLegacyAccessor(source, glb1, original.indices));
      }
      vertices += document.accessors[primitive.attributes.POSITION].count;
      assert.equal(primitive.mode ?? 4, 4, 'Qualification fixture must contain triangles');
      triangles += document.accessors[primitive.indices ?? primitive.attributes.POSITION].count / 3;
    }
  }
  const name = path.basename(sample.path, '.b3dm') + '.glb';
  const properties = buildTilesProperties(sample.sha256, inspected.batchLength, inspected.batchTable, referencedBatchIds);
  assert.equal(properties.model.referencedFeatureCount, inspected.batchLength, 'Lost fixture feature');
  const propertiesBytes = Buffer.from(JSON.stringify(properties, null, 2));
  const propertiesFile = path.basename(sample.path, '.b3dm') + '.properties.json';
  await writeFile(path.join(output, propertiesFile), propertiesBytes);
  await writeFile(path.join(output, name), first.glb);
  results.push({ source: sample.path, sourceSha256: sample.sha256, output: name,
    sha256: hash(first.glb), bytes: first.glb.length, vertices, triangles,
    sourceBatchLength: inspected.batchLength, sourceRtcCenter: center, nodeIoLoaded: true, worldMaxError,
    extensionsRequired: document.extensionsRequired, exactDecodedAttributesAndIndices: true,
    properties: { path: propertiesFile, sha256: hash(propertiesBytes), features: properties.model.featureCount } });
}
assert.equal(results.length, 5);
await writeFile(path.join(output, 'evidence.json'), JSON.stringify({
  scope: 'Candidate GLB 1 to 2 conversion; decoded local attributes and indices only',
  measuredAt: new Date().toISOString(), version: packageInfo.version,
  lockSha256: hash(await readFile(path.join(root, 'package-lock.json'))),
  license: packageInfo.license, results,
  remaining: ['Tileset transforms/CRS, material appearance, feature identity and visual acceptance',
    'Dependency distribution/license closure and production worker integration'],
}, null, 2));
console.log(JSON.stringify({ output, results }, null, 2));

function readLegacyAccessor(document, bytes, id) {
  const accessor = document.accessors[id];
  const view = document.bufferViews[accessor.bufferView];
  const version = bytes.readUInt32LE(4);
  assert.equal(view.buffer, version === 1 ? 'binary_glTF' : 0);
  const types = { 5120: [1, 'getInt8'], 5121: [1, 'getUint8'], 5122: [2, 'getInt16'],
    5123: [2, 'getUint16'], 5125: [4, 'getUint32'], 5126: [4, 'getFloat32'] };
  const [size, getter] = types[accessor.componentType];
  const components = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }[accessor.type];
  assert.ok(components);
  const dataStart = 20 + bytes.readUInt32LE(12) + (version === 2 ? 8 : 0);
  if (version === 2) assert.equal(bytes.readUInt32LE(dataStart - 4), 0x004e4942);
  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const result = [];
  for (let i = 0; i < accessor.count; i++) {
    for (let c = 0; c < components; c++) {
      const offset = dataStart + (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0)
        + i * (accessor.byteStride || view.byteStride || size * components) + c * size;
      result.push(data[getter](offset, true));
    }
  }
  return result;
}

function worldVertices(document, bytes, rtc) {
  const result = [];
  const visit = (index, parent, ancestry) => {
    assert.ok(!ancestry.has(index), 'Cyclic fixture node graph');
    const next = new Set(ancestry).add(index);
    const node = document.nodes[index];
    const local = node.matrix ? new Matrix4().fromArray(node.matrix) : new Matrix4().compose(
      new Vector3(...(node.translation ?? [0, 0, 0])),
      new Quaternion(...(node.rotation ?? [0, 0, 0, 1])), new Vector3(...(node.scale ?? [1, 1, 1])));
    const world = parent.clone().multiply(local);
    for (const mesh of node.meshes ?? (node.mesh === undefined ? [] : [node.mesh])) {
      for (const primitive of document.meshes[mesh].primitives) {
        const positions = readLegacyAccessor(document, bytes, primitive.attributes.POSITION);
        for (let i = 0; i < positions.length; i += 3) {
          const point = new Vector3(...positions.slice(i, i + 3)).applyMatrix4(world);
          // glTF Y-up 转 Tiles Z-up，再加原 RTC；标准父节点路径的 rtc 为零。
          result.push([point.x + rtc[0], -point.z + rtc[1], point.y + rtc[2]]);
        }
      }
    }
    for (const child of node.children ?? []) visit(child, world, next);
  };
  for (const scene of Object.values(document.scenes)) {
    for (const node of scene.nodes) visit(node, new Matrix4(), new Set());
  }
  return result;
}
