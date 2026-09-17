import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { read3dmTextureResource } from './3dm-texture-resource.mjs';
const root = resolve(import.meta.dirname, '../..');
const out = resolve(root, 'test-output/3dm-source-audit');
const hash = b => createHash('sha256').update(b).digest('hex');
const sourceBytes = readFileSync(resolve(out, 'meshWithTexture.3dm.json'));
const source = JSON.parse(sourceBytes);
const sourceEvidence = JSON.parse(readFileSync(resolve(out, 'evidence.json')));
assert.equal(hash(sourceBytes), sourceEvidence.results.find(r => r.name === 'meshWithTexture.3dm').outputSha256);
const negatives = [];
for (const material of source.materials) for (const texture of material.textures) {
  let code;
  try { await read3dmTextureResource(out, { relativePath: texture.fullPath }); }
  catch (error) { code = error.message; }
  assert.equal(code, 'resource-path-unsafe');
  negatives.push({ textureId: texture.id, path: texture.fullPath, relativePath: texture.relativePath,
    mappingChannelId: texture.mappingChannelId, status: 'identity-only', rejection: code });
}
const candidate = resolve(out, 'developer-sample/hello_mesh.3dm');
const candidateSha256 = hash(readFileSync(candidate));
assert.equal(candidateSha256, '5a22a1a79df6a6aa755adc846f0cedbfe2a047e3844cd43de691df843e2db9d3');
const parsed = spawnSync(resolve(out, '3dm-source-audit.exe'), [candidate], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
assert.equal(parsed.status, 0, parsed.stderr);
const model = JSON.parse(parsed.stdout);
const textures = model.materials.flatMap(m => m.textures);
assert.equal(textures.length, 0);
const evidence = { schemaVersion: 1, sourceJsonSha256: hash(sourceBytes), negatives,
  alternative: { repository: 'https://github.com/mcneel/rhino-developer-samples',
    revision: '8462fc3487f8b7a58595ef73f6a5c09f92717f60',
    path: 'rhino3dm/js/SampleViewer/02_advanced/hello_mesh.3dm', sha256: candidateSha256,
    objects: model.objects.length, materials: model.materials.length, textures: textures.length,
    licenseSha256: hash(readFileSync(resolve(out, 'developer-sample/License.md'))),
    viewerScriptGitBlob: 'b5a6966fa4365fcbdd15347c3a8b80f8c348b5f4',
    status: 'no-source-texture-reference; viewer-applies-overrides' },
  embedDecision: 'identity-only: no verified source-linked distributable image and mapping' };
writeFileSync(resolve(out, 'texture-availability-evidence.json'), JSON.stringify(evidence, null, 2));
console.log(JSON.stringify(evidence, null, 2));
