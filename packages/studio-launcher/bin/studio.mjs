#!/usr/bin/env node
import { mkdir, readFile, writeFile, access, rename, rm } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createServer } from 'node:net';
import { installRegistryRuntime } from './registry-runtime.mjs';

const args = process.argv.slice(2), run = promisify(execFile);
if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('DeepMonkey Studio requires Node.js 24+');
if (args.includes('--help') || args.includes('-h')) {
  console.log('deepmonkey-studio [--port 4100] [--data-dir directory] [--cache-dir directory] [--no-open] [--prepare-only]');
  process.exit(0);
}
function option(name, fallback) { const index = args.indexOf(name); if (index < 0) return fallback; if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`Missing ${name}`); return args[index + 1]; }
let port = Number(option('--port', process.env.API_PORT ?? '4100'));
if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) throw new Error('Choose a port between 1024 and 65535');
if (!args.includes('--prepare-only')) {
  const explicitPort = args.includes('--port') || Boolean(process.env.API_PORT);
  for (let attempt = 0; ; attempt++) {
    try {
      await new Promise((done, reject) => { const probe = createServer(); probe.once('error', reject); probe.listen(port, '127.0.0.1', () => probe.close(done)); });
      break;
    } catch (error) {
      if (error.code !== 'EADDRINUSE' || explicitPort || attempt >= 9 || port === 65535) throw new Error(`Port ${port} is unavailable; choose --port`, { cause: error });
      console.log(`Port ${port} is occupied; trying ${port + 1}`); port++;
    }
  }
}
const home = resolve(process.env.DEEPMONKEY_HOME ?? join(process.env.LOCALAPPDATA ?? join(homedir(), '.local/share'), 'DeepMonkeyStudio'));
const data = resolve(option('--data-dir', join(home, 'data')));
const cache = resolve(option('--cache-dir', join(home, 'runtime')));
const release = JSON.parse(await readFile(new URL('../runtime-manifest.json', import.meta.url), 'utf8'));
const manifest = { ...release, ...release.platforms?.[`${process.platform}-${process.arch}`] };
const runtime = join(cache, `${manifest.version}-${manifest.sha256.slice(0, 12)}`);
const ready = join(runtime, '.ready.json');
const npmCli = process.env.npm_execpath ?? join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
async function npmInstall() {
  const child = spawn(process.execPath, [npmCli, 'install', '--omit=dev', '--no-audit', '--no-fund', '--fetch-timeout=120000', '--fetch-retries=2'], { cwd: runtime, stdio: 'inherit', windowsHide: true,
    env: { ...process.env, ONNXRUNTIME_NODE_INSTALL: 'skip' } });
  const code = await new Promise((done, reject) => { child.once('error', reject); child.once('exit', done); });
  if (code) throw new Error(`Runtime dependency installation exited with ${code}; rerun to retry`);
}
try { const cached = JSON.parse(await readFile(ready, 'utf8')); if (cached.sha256 !== manifest.sha256 || cached.version !== manifest.version) throw new Error('Runtime cache manifest changed'); }
catch {
  await mkdir(cache, { recursive: true });
  await mkdir(runtime, { recursive: true });
  if (manifest.npmPackages) {
    await installRegistryRuntime(manifest, runtime, cache, npmCli);
    if (!manifest.dependenciesInstalled) await npmInstall();
    await writeFile(ready, JSON.stringify({ version: manifest.version, sha256: manifest.sha256 }) + '\n');
  } else {
  const archive = join(cache, `${manifest.version}-${randomUUID()}.tar.gz`);
  const temporary = `${archive}.part`, hash = createHash('sha256');
  console.log(`Downloading Studio ${manifest.version} (${Math.ceil(manifest.bytes / 1_000_000)} MB)…`);
  const response = await fetch(manifest.url, { signal: AbortSignal.timeout(600_000) });
  if (!response.ok || !response.body) throw new Error(`Runtime download failed (${response.status})`);
  let bytes = 0;
  try { await pipeline(Readable.fromWeb(response.body), new Transform({ transform(chunk, _encoding, callback) {
    bytes += chunk.length; if (bytes > manifest.bytes) { callback(new Error('Runtime exceeds its manifest size')); return; }
    hash.update(chunk); callback(null, chunk);
  } }), createWriteStream(temporary, { flags: 'wx' }));
  if (bytes !== manifest.bytes || hash.digest('hex') !== manifest.sha256) throw new Error('Runtime checksum mismatch');
  await rename(temporary, archive);
  } catch (error) { await rm(temporary, { force: true }); throw error; }
  const listing = await run('tar', ['-tzf', archive], { maxBuffer: 16 * 1024 ** 2, windowsHide: true });
  if (listing.stdout.split(/\r?\n/).filter(Boolean).some(path => path.startsWith('/') || /^[A-Za-z]:/.test(path) || path.includes('\\') || path.split('/').includes('..'))) throw new Error('Unsafe runtime archive path');
  await run('tar', ['-xzf', archive, '-C', runtime], { windowsHide: true });
  await rm(archive);
  if (!manifest.dependenciesInstalled) await npmInstall();
  await writeFile(ready, JSON.stringify({ version: manifest.version, sha256: manifest.sha256 }) + '\n');
  }
}
// The launcher also supplies the default client branding to older runtime caches.
const icon = join(runtime, 'apps/desktop/src-tauri/icons/icon.ico');
try { await access(icon); }
catch (error) {
  if (error.code !== 'ENOENT') throw error;
  await mkdir(dirname(icon), { recursive: true });
  await writeFile(icon, await readFile(new URL('./studio.ico', import.meta.url)), { flag: 'wx' });
}
console.log(`Studio runtime: ${runtime}\nProject data: ${data}`);
if (args.includes('--prepare-only')) process.exit(0);
await mkdir(data, { recursive: true });
try { await access(join(data, 'database.json')); }
catch { await writeFile(join(data, 'database.json'), await readFile(join(runtime, 'examples/database.seed.json')), { flag: 'wx' }); }
const origin = `http://localhost:${port}`;
const native = join(runtime, 'publication/native/deep-engine-native.exe');
const child = spawn(process.execPath, ['scripts/docker-entrypoint.mjs'], { cwd: runtime, stdio: 'inherit', windowsHide: true,
  env: { ...process.env, NODE_ENV: 'production', BIM_STUDIO_STORAGE_MODE: 'standalone', API_HOST: '127.0.0.1', API_PORT: String(port),
    DATA_DIR: data, WEB_DIST_DIR: join(runtime, 'apps/web/dist'), WEB_ORIGIN: origin,
    ...(process.platform === 'win32' ? { NATIVE_SCENE_VERIFIER_EXECUTABLE: native,
      THREE_SCENE_VIEWER_LAUNCHER_EXECUTABLE: join(runtime, 'publication/webview/scene-viewer.exe') } : {}) } });
let launched = false;
const poll = setInterval(async () => {
  try {
    const response = await fetch(`${origin}/api/meta`, { signal: AbortSignal.timeout(1000) });
    if (!response.ok || launched) return;
    launched = true; clearInterval(poll);
    console.log(`Open ${origin}\nAccount: admin\nPassword: ${join(data, 'standalone-credentials.json')} (adminPassword)`);
    if (!args.includes('--no-open')) {
      const command = process.platform === 'win32' ? 'explorer.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
      const opener = spawn(command, [origin], { stdio: 'ignore', windowsHide: true }); opener.on('error', () => {}); opener.unref();
    }
  } catch { /* API is still starting. */ }
}, 500);
child.once('error', error => { clearInterval(poll); throw error; });
child.once('exit', code => { clearInterval(poll); process.exit(code ?? 1); });
process.on('SIGINT', () => child.kill('SIGINT'));
process.on('SIGTERM', () => child.kill('SIGTERM'));
