import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { prepareDockerDeployment } from './prepare-release-docker-bundle.mjs';
const manifest = { version: '0.2.0', revision: 'a'.repeat(40), sha256: 'b'.repeat(64),
  savedImages: ['deep-monkey-studio:0.2.0', 'postgres:18-alpine', 'deep-monkey-minio:2025.5.24'] };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
test('offline deployment includes exact Compose, empty credentials, checksums and no-pull startup', async () => {
  const output = await mkdtemp(join(tmpdir(), 'studio-docker-deployment-'));
  const result = await prepareDockerDeployment({ manifest, output });
  assert.equal(result.imageArchive, 'DeepMonkey-Studio-Docker-0.2.0.tar.gz');
  assert.equal(hash(await readFile(join(output, result.archive))), result.sha256);
  for (const name of ['docker-compose.yml', 'docker-compose.app.yml'])
    assert.deepEqual(await readFile(join(output, 'docker', name)), await readFile(name));
  const environment = await readFile(join(output, 'docker/.env.example'), 'utf8');
  for (const name of ['POSTGRES_PASSWORD', 'MINIO_ROOT_PASSWORD', 'BIM_STUDIO_ADMIN_PASSWORD', 'BIM_STUDIO_SESSION_SECRET'])
    assert.ok(environment.split('\n').includes(`${name}=`));
  for (const name of ['start.ps1', 'start.sh']) {
    const source = await readFile(join(output, 'docker', name), 'utf8');
    assert.ok(source.includes('--no-build --pull never'));
    assert.ok(!source.includes('{{VERSION}}'));
    assert.ok(!source.includes('down -v'));
    assert.match(source, name.endsWith('.ps1') ? /SHA256.*Create/ : /sha256sum --check/);
  }
  const checksums = await readFile(join(output, 'docker/SHA256SUMS.txt'), 'utf8');
  for (const file of result.files) assert.ok(checksums.includes(`${file.sha256}  ${file.path}`));
  assert.ok(checksums.includes(`${manifest.sha256}  ${result.imageArchive}`));
});
test('invalid image identity rejects before producing deployment files', async () => {
  await assert.rejects(prepareDockerDeployment({ manifest: { ...manifest, version: '../bad' }, output: '' }));
  await assert.rejects(prepareDockerDeployment({ manifest: { ...manifest, sha256: 'missing' }, output: '' }));
});
test('PowerShell startup verifies archive before Docker and preserves existing local credentials', { skip: process.platform !== 'win32' }, async () => {
  const output = await mkdtemp(join(tmpdir(), 'studio-docker-startup-'));
  const image = Buffer.from('isolated archive fixture; Docker calls are intercepted');
  const fixtureManifest = { ...manifest, sha256: createHash('sha256').update(image).digest('hex') };
  await prepareDockerDeployment({ manifest: fixtureManifest, output });
  const stage = join(output, 'docker');
  await writeFile(join(stage, 'DeepMonkey-Studio-Docker-0.2.0.tar.gz'), image);
  const harness = join(stage, 'test-start.ps1');
  await writeFile(harness, `function global:docker { Add-Content -LiteralPath "$PSScriptRoot/calls.txt" -Value ($args -join ' '); $global:LASTEXITCODE=0 }\n& "$PSScriptRoot/start.ps1"\n`);
  const run = () => spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', harness], { encoding: 'utf8', windowsHide: true });
  let executed = run(); assert.equal(executed.status, 0, executed.stderr);
  const first = await readFile(join(stage, '.env'), 'utf8');
  for (const name of ['POSTGRES_PASSWORD', 'MINIO_ROOT_PASSWORD', 'BIM_STUDIO_ADMIN_PASSWORD', 'BIM_STUDIO_SESSION_SECRET'])
    assert.match(first, new RegExp(`^${name}=[a-f0-9]{48}$`, 'm'));
  assert.match(await readFile(join(stage, 'calls.txt'), 'utf8'), /up -d --no-build --pull never/);
  executed = run(); assert.equal(executed.status, 0, executed.stderr);
  assert.equal(await readFile(join(stage, '.env'), 'utf8'), first);
  const calls = await readFile(join(stage, 'calls.txt'), 'utf8');
  await writeFile(join(stage, 'DeepMonkey-Studio-Docker-0.2.0.tar.gz'), Buffer.from('corrupt'));
  executed = run(); assert.notEqual(executed.status, 0);
  assert.match(executed.stderr, /SHA-256 mismatch/);
  assert.equal(await readFile(join(stage, 'calls.txt'), 'utf8'), calls);
});
test('POSIX startup validates archive and reuses credentials without pulling images', async () => {
  const output = await mkdtemp(join(tmpdir(), 'studio-docker-posix-'));
  const image = Buffer.from('isolated POSIX image fixture; no actual Docker calls');
  await prepareDockerDeployment({ manifest: { ...manifest, sha256: createHash('sha256').update(image).digest('hex') }, output });
  const stage = join(output, 'docker');
  await writeFile(join(stage, 'DeepMonkey-Studio-Docker-0.2.0.tar.gz'), image);
  await writeFile(join(stage, 'test-start.sh'), 'docker() { printf "%s\\n" "$*" >> calls.txt; }\n. ./start.sh\n');
  let shell = '/bin/sh';
  if (process.platform === 'win32') {
    const git = spawnSync('git', ['--exec-path'], { encoding: 'utf8', windowsHide: true });
    assert.equal(git.status, 0, git.stderr);
    shell = resolve(git.stdout.trim(), '../../../bin/bash.exe');
  }
  const run = () => spawnSync(shell, ['test-start.sh'], { cwd: stage, encoding: 'utf8', windowsHide: true });
  let executed = run(); assert.equal(executed.status, 0, executed.stderr);
  const first = await readFile(join(stage, '.env'), 'utf8');
  for (const name of ['POSTGRES_PASSWORD', 'MINIO_ROOT_PASSWORD', 'BIM_STUDIO_ADMIN_PASSWORD', 'BIM_STUDIO_SESSION_SECRET'])
    assert.match(first, new RegExp(`^${name}=[a-f0-9]{48}$`, 'm'));
  executed = run(); assert.equal(executed.status, 0, executed.stderr);
  assert.equal(await readFile(join(stage, '.env'), 'utf8'), first);
  const calls = await readFile(join(stage, 'calls.txt'), 'utf8');
  assert.match(calls, /up -d --no-build --pull never/);
  await writeFile(join(stage, 'DeepMonkey-Studio-Docker-0.2.0.tar.gz'), Buffer.from('corrupt'));
  executed = run(); assert.notEqual(executed.status, 0);
  assert.equal(await readFile(join(stage, 'calls.txt'), 'utf8'), calls);
});
