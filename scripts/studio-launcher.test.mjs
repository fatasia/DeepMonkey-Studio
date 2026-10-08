import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, cp, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const root = resolve(import.meta.dirname, '..');
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'deepmonkey-launcher-test-'));
  t.after(async () => { assert.ok(directory.startsWith(join(tmpdir(), 'deepmonkey-launcher-test-'))); await rm(directory, { recursive: true, force: true }); });
  const stage = join(directory, 'stage'); await mkdir(stage);
  await writeFile(join(stage, 'package.json'), '{"private":true}');
  await writeFile(join(stage, 'runtime-proof.txt'), 'verified runtime');
  const archive = join(directory, 'runtime.tar.gz');
  await run('tar', ['-czf', archive, '-C', stage, '.']);
  const bytes = await readFile(archive), sha256 = createHash('sha256').update(bytes).digest('hex');
  let downloads = 0;
  const server = createServer((_req, response) => { downloads++; response.end(bytes); });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  t.after(() => new Promise(done => server.close(done)));
  const launcher = join(directory, 'launcher'); await mkdir(join(launcher, 'bin'), { recursive: true });
  await cp(join(root, 'packages/studio-launcher/bin'), join(launcher, 'bin'), { recursive: true });
  const manifest = { version: '0.2.0', sha256, bytes: bytes.length, url: `http://127.0.0.1:${server.address().port}/runtime` };
  await writeFile(join(launcher, 'runtime-manifest.json'), JSON.stringify(manifest));
  const npm = join(directory, 'npm-test.js');
  await writeFile(npm, 'require("node:fs").appendFileSync("install-proof.txt", "installed\\n");');
  const cache = join(directory, 'cache'), data = join(directory, 'data');
  const invoke = (...args) => run(process.execPath, [join(launcher, 'bin/studio.mjs'), '--cache-dir', cache, '--data-dir', data, ...args], { env: { ...process.env, npm_execpath: npm }, timeout: 30000 });
  return { directory, launcher, manifest, cache, data, npm, archive, invoke, downloads: () => downloads };
}

test('verified download installs once and cached preparation preserves user data', async t => {
  const f = await fixture(t);
  await mkdir(f.data); await writeFile(join(f.data, 'database.json'), '{"sentinel":"keep"}');
  await f.invoke('--prepare-only'); await f.invoke('--prepare-only');
  assert.equal(f.downloads(), 1);
  const runtime = join(f.cache, `0.2.0-${f.manifest.sha256.slice(0, 12)}`);
  assert.equal(await readFile(join(runtime, 'runtime-proof.txt'), 'utf8'), 'verified runtime');
  assert.equal(await readFile(join(runtime, 'install-proof.txt'), 'utf8'), 'installed\n');
  assert.equal(await readFile(join(f.data, 'database.json'), 'utf8'), '{"sentinel":"keep"}');
});

test('checksum mismatch prevents extraction, installation and ready state', async t => {
  const f = await fixture(t); f.manifest.sha256 = '0'.repeat(64);
  await writeFile(join(f.launcher, 'runtime-manifest.json'), JSON.stringify(f.manifest));
  await assert.rejects(f.invoke('--prepare-only'), /Runtime checksum mismatch/);
  const runtime = join(f.cache, '0.2.0-000000000000');
  await assert.rejects(access(join(runtime, 'runtime-proof.txt')));
  await assert.rejects(access(join(runtime, '.ready.json')));
});

test('invalid ports fail before any download', async t => {
  const f = await fixture(t);
  await assert.rejects(f.invoke('--port', 'NaN', '--prepare-only'), /Choose a port/);
  assert.equal(f.downloads(), 0);
});

test('platform bundle skips installation and is reused', async t => {
  const f = await fixture(t);
  const variant = { ...f.manifest, dependenciesInstalled: true };
  f.manifest.url = 'http://127.0.0.1:1/unused-base';
  f.manifest.platforms = { [`${process.platform}-${process.arch}`]: variant };
  await writeFile(join(f.launcher, 'runtime-manifest.json'), JSON.stringify(f.manifest));
  await f.invoke('--prepare-only'); await f.invoke('--prepare-only');
  assert.equal(f.downloads(), 1);
  const runtime = join(f.cache, `0.2.0-${variant.sha256.slice(0, 12)}`);
  await assert.rejects(access(join(runtime, 'install-proof.txt')));
  assert.equal(JSON.parse(await readFile(join(runtime, '.ready.json'))).sha256, variant.sha256);
});

test('registry payload is verified, extracted and reused without GitHub access', async t => {
  const f = await fixture(t);
  const packageRoot = join(f.directory, 'registry'); await mkdir(join(packageRoot, 'package'), { recursive: true });
  await cp(f.archive, join(packageRoot, 'package/runtime.tar.gz'));
  const packed = join(f.directory, 'registry.tgz'); await run('tar', ['-czf', packed, '-C', packageRoot, 'package']);
  await writeFile(f.npm, `const fs = require('node:fs'), path = require('node:path');
const dest = process.argv[process.argv.indexOf('--pack-destination') + 1];
fs.copyFileSync(${JSON.stringify(packed)}, path.join(dest, 'registry.tgz'));
process.stdout.write(JSON.stringify([{filename:'registry.tgz'}]));`);
  const manifest = { ...f.manifest, dependenciesInstalled: true, npmPackages: [{ package: 'test-runtime@1.0.0', sha256: f.manifest.sha256, bytes: f.manifest.bytes }] };
  await writeFile(join(f.launcher, 'runtime-manifest.json'), JSON.stringify(manifest));
  await f.invoke('--prepare-only');
  assert.equal(f.downloads(), 0);
  const runtime = join(f.cache, `0.2.0-${manifest.sha256.slice(0, 12)}`);
  assert.equal(await readFile(join(runtime, 'runtime-proof.txt'), 'utf8'), 'verified runtime');
  await rm(join(runtime, '.ready.json'));
  await writeFile(f.npm, 'process.exit(1)');
  const again = await f.invoke('--prepare-only'); assert.match(again.stdout, /Using cached/);
});
