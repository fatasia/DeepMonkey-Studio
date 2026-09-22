import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, mkdir, writeFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { summarizeGlbDocument } from '../lib/glbAudit.mjs';
import { inspectB3dmContainer } from '../lib/industrialB3dmPreflight.mjs';

// Qualification of the pinned upstream parser, not a production import gate.
const root = path.resolve('data/external-assets/industrial-format-plan/build-trial/3dtiles-renderer');
const fixtureRoot = path.resolve('data/external-assets/format-fixtures');
const output = path.resolve(process.argv[2] ?? 'test-output/industrial-tiles-source-20260918');
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const { B3DMLoaderBase } = await import(pathToFileURL(path.join(root, 'src/core/renderer/loaders/B3DMLoaderBase.js')));
const { traverseSet } = await import(pathToFileURL(path.join(root, 'src/core/renderer/utilities/TraversalUtils.js')));
const manifest = JSON.parse(await readFile(path.join(fixtureRoot, 'manifest.json'), 'utf8'));
const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
assert.equal(packageJson.version, '0.5.2');
const samples = manifest.samples.filter((sample) => sample.format === '3d-tiles');
assert.equal(samples.length, 6);
const loaded = new Map();
for (const sample of samples) {
  const bytes = await readFile(path.join(fixtureRoot, sample.path));
  assert.equal(bytes.length, sample.bytes);
  assert.equal(sha256(bytes), sample.sha256);
  loaded.set(path.basename(sample.path), bytes);
}
const tileset = JSON.parse(loaded.get('tileset.json'));
const nodes = [];
traverseSet(tileset.root, (tile, parent, depth) => {
  const uri = tile.content?.uri ?? tile.content?.url;
  assert.ok(loaded.has(uri), `Unresolved fixture resource: ${uri}`);
  nodes.push({ uri, depth, geometricError: tile.geometricError, hasParent: parent !== null });
});
assert.equal(nodes.length, 5);
assert.equal(nodes.filter((node) => node.depth === 1).length, 4);
const parser = new B3DMLoaderBase();
const parse = (bytes) => parser.parse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
const positive = [];
for (const node of nodes) {
  const preflight = inspectB3dmContainer(loaded.get(node.uri));
  const parsed = parse(loaded.get(node.uri));
  const glb = Buffer.from(parsed.glbBytes);
  assert.equal(glb.toString('ascii', 0, 4), 'glTF');
  assert.equal(glb.readUInt32LE(8), glb.length);
  const version = glb.readUInt32LE(4);
  assert.ok(version === 1 || version === 2);
  const jsonLength = glb.readUInt32LE(12);
  // Both GLB versions have a 20-byte prefix; v1 uses contentFormat=0.
  assert.equal(glb.readUInt32LE(16), version === 1 ? 0 : 0x4e4f534a);
  assert.ok(jsonLength > 0 && jsonLength + 20 <= glb.length);
  const document = JSON.parse(glb.toString('utf8', 20, 20 + jsonLength).trim());
  const declaredMetrics = version === 2 ? summarizeGlbDocument(document) : {
    nodeCount: Object.keys(document.nodes ?? {}).length,
    meshCount: Object.keys(document.meshes ?? {}).length,
    materialCount: Object.keys(document.materials ?? {}).length,
    externalUris: [...Object.values(document.buffers ?? {}), ...Object.values(document.images ?? {})]
      .map((item) => item.uri).filter((uri) => typeof uri === 'string' && !uri.startsWith('data:')),
    note: 'Legacy GLB 1 object dictionaries; no geometry conversion performed.',
  };
  positive.push({ ...node, preflight, b3dmVersion: parsed.version, glbVersion: version,
    glbBytes: glb.length, glbSha256: sha256(glb), declaredMetrics });
}
const parent = loaded.get('parent.b3dm');
const mutate = (change) => { const bytes = Buffer.from(parent); change(bytes); return bytes; };
const invalid = [
  ['bad-magic', mutate((bytes) => bytes.write('xxxx', 0, 'ascii'))],
  ['unsupported-version', mutate((bytes) => bytes.writeUInt32LE(99, 4))],
  ['short-declared-length', mutate((bytes) => bytes.writeUInt32LE(bytes.length - 1, 8))],
  ['truncated-header', parent.subarray(0, 12)],
  ['truncated-body', parent.subarray(0, parent.length - 1)],
  ['table-length-overflow', mutate((bytes) => bytes.writeUInt32LE(0xffffffff, 12))],
];
const negative = [];
for (const [name, bytes] of invalid) {
  assert.throws(() => inspectB3dmContainer(bytes), /B3DM:/, `Preflight must reject ${name}`);
  let assertions = 0;
  const originalAssert = console.assert;
  console.assert = (condition) => { if (!condition) assertions += 1; };
  try {
    const result = parse(bytes);
    negative.push({ name, preflightRejected: true, rejected: false, assertions, returnedGlbBytes: result.glbBytes.length });
  } catch (error) {
    negative.push({ name, preflightRejected: true, rejected: true, assertions, error: String(error.message) });
  } finally { console.assert = originalAssert; }
}
// Freeze the observed upstream weakness: console.assert does not reject inputs.
assert.deepEqual(negative.filter((test) => !test.rejected).map((test) => test.name),
  ['bad-magic', 'unsupported-version', 'short-declared-length']);
const sourceFiles = [];
async function inventory(directory) {
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, item.name);
    if (item.isDirectory()) await inventory(file);
    else if (item.isFile()) {
      const bytes = await readFile(file);
      sourceFiles.push({ path: path.relative(root, file).replaceAll('\\', '/'), bytes: bytes.length, sha256: sha256(bytes) });
    }
  }
}
await inventory(path.join(root, 'src'));
await inventory(path.join(root, 'build'));
const runtime = process.resourceUsage();
const evidence = {
  schemaVersion: 1, measuredAt: new Date().toISOString(), scope: 'S0 source qualification; no production geometry acceptance',
  upstream: { name: packageJson.name, version: packageJson.version, license: packageJson.license,
    packageLockSha256: sha256(await readFile(path.join(root, 'package-lock.json'))) },
  runtime: { node: process.version, platform: process.platform, arch: process.arch,
    nodeExecutableBytes: (await stat(process.execPath)).size, maxRssKiB: runtime.maxRSS },
  sourceBytes: sourceFiles.filter((file) => file.path.startsWith('src/')).reduce((sum, file) => sum + file.bytes, 0),
  buildEntryBytes: sourceFiles.filter((file) => file.path.startsWith('build/')).reduce((sum, file) => sum + file.bytes, 0),
  positive, negative, sourceFiles,
  gaps: ['Strict preflight rejects all six malformed fixtures; production worker integration is still pending.',
    'Build entries re-export source; entry bytes are not total installed runtime size.',
    'GLB metrics describe JSON declarations, not decoded mesh/topology validation.',
    'This run does not verify installation, dependency license closure, renderer integration or production cancellation.'],
};
await mkdir(output, { recursive: true });
await writeFile(path.join(output, 'evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`);
console.log(JSON.stringify({ output, positive: positive.length, negative, sourceBytes: evidence.sourceBytes,
  buildEntryBytes: evidence.buildEntryBytes, maxRssKiB: runtime.maxRSS }, null, 2));
