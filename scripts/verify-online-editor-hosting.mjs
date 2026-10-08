import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, writeFile, rm, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

const dir = await mkdtemp(join(tmpdir(), 'studio-online-config-'));
const envFile = join(dir, 'qa.env');
try {
  const secret = () => randomBytes(24).toString('hex');
  await writeFile(envFile, ['POSTGRES_PASSWORD','MINIO_USER','MINIO_PASSWORD','ADMIN_PASSWORD','SESSION_SECRET']
    .map(key => `STUDIO_ONLINE_${key}=${secret()}`).join('\n'));
  const result = spawnSync('docker', ['compose', '--env-file', envFile, '-f', 'deploy/online-editor/compose.yml', 'config', '--format', 'json'],
    { encoding: 'utf8', cwd: new URL('../', import.meta.url), maxBuffer: 1024 ** 2 });
  assert.equal(result.status, 0, 'Docker Compose must parse the isolated deployment');
  const config = JSON.parse(result.stdout);
  assert.equal(config.name, 'studio-online-editor');
  assert.equal(config.services.studio.ports.length, 1);
  assert.equal(config.services.studio.ports[0].host_ip, '127.0.0.1');
  assert.equal(String(config.services.studio.ports[0].published), '44100');
  for (const service of ['postgres', 'minio']) { assert.equal(config.services[service].ports, undefined); assert.equal(config.services[service].container_name, undefined); }
  assert.equal(config.services.studio.environment.WEB_ORIGIN, 'http://localhost:44101');
  for (const volume of Object.values(config.volumes)) assert.match(volume.name, /^studio-online-editor_/);
  console.log(JSON.stringify({ compose: 'passed', boundOnlyToLoopback: true, ports: ['127.0.0.1:44100'], isolatedStores: 3,
    containersStarted: false, published: false }, null, 2));
} finally { await rm(envFile, { force: true }); await rmdir(dir); }
