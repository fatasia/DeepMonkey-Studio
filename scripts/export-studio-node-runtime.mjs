import { cp, mkdir, readFile, writeFile, readdir, access } from 'node:fs/promises';
import { resolve, join, relative } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';

const root = resolve(import.meta.dirname, '..'), run = promisify(execFile);
const lock = JSON.parse((await run('python', ['-c', 'import json,yaml; print(json.dumps(yaml.safe_load(open("pnpm-lock.yaml", encoding="utf-8"))))'], { cwd: root, maxBuffer: 16 * 1024 ** 2 })).stdout);
const finalize = process.argv[2] === '--finalize';
const output = resolve((finalize ? process.argv[3] : process.argv[2]) ?? 'artifacts/releases/0.2.0/node-runtime');
const stage = join(output, 'runtime');
await mkdir(stage, { recursive: true });
if (!finalize && (await readdir(stage)).length) throw new Error('Choose a new runtime output directory');
if (!finalize) {
const packages = new Map();
for (const entry of await readdir(join(root, 'packages'), { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const path = `packages/${entry.name}`;
  try { const manifest = JSON.parse(await readFile(join(root, path, 'package.json'), 'utf8')); packages.set(manifest.name, { path, manifest }); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}
const api = JSON.parse(await readFile(join(root, 'apps/api/package.json'), 'utf8'));
const chosen = new Set();
function visit(manifest) {
  for (const name of Object.keys(manifest.dependencies ?? {})) {
    if (!name.startsWith('@bim-studio/')) continue;
    const item = packages.get(name); if (!item) throw new Error(`Missing runtime package: ${name}`);
    if (!chosen.has(name)) { chosen.add(name); visit(item.manifest); }
  }
}
visit(api);
async function copyPackage(path, original) {
  const destination = join(stage, path); await mkdir(destination, { recursive: true });
  const manifest = structuredClone(original); delete manifest.devDependencies; delete manifest.scripts;
  delete manifest.bin; manifest.private = true;
  for (const [name, value] of Object.entries(manifest.dependencies ?? {})) {
    if (value.startsWith('workspace:')) manifest.dependencies[name] = `file:${relative(destination, join(stage, packages.get(name).path)).replaceAll('\\', '/')}`;
    else {
      const locked = lock.importers[path]?.dependencies?.[name]?.version?.split('(')[0];
      if (!locked) throw new Error(`Missing locked dependency: ${path} ${name}`);
      manifest.dependencies[name] = value.startsWith('npm:') ? `npm:${locked}` : locked;
    }
  }
  for (const value of Object.values(manifest.exports ?? {})) if (value && typeof value === 'object') delete value.development;
  await writeFile(join(destination, 'package.json'), JSON.stringify(manifest, null, 2));
  await cp(join(root, path, 'dist'), join(destination, 'dist'), { recursive: true, dereference: true });
  for (const directory of ['assets', 'models', 'resources', 'schemas', 'wasm']) {
    try { await access(join(root, path, directory)); await cp(join(root, path, directory), join(destination, directory), { recursive: true, dereference: true }); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}
await copyPackage('apps/api', api);
for (const name of chosen) { const item = packages.get(name); await copyPackage(item.path, item.manifest); }
await cp(join(root, 'apps/web/dist'), join(stage, 'apps/web/dist'), { recursive: true, dereference: true });
await cp(join(root, 'apps/web/public/assets/nature-kit'), join(stage, 'apps/web/public/assets/nature-kit'), { recursive: true });
await mkdir(join(stage, 'apps/desktop/src-tauri/icons'), { recursive: true });
await cp(join(root, 'apps/desktop/src-tauri/icons/icon.ico'), join(stage, 'apps/desktop/src-tauri/icons/icon.ico'));
await mkdir(join(stage, 'scripts'));
await cp(join(root, 'scripts/docker-entrypoint.mjs'), join(stage, 'scripts/docker-entrypoint.mjs'));
await cp(join(root, 'apps/desktop/src-tauri/target/release/local-api/publication/native'), join(stage, 'publication/native'), { recursive: true });
await cp(join(root, 'tools/libredwg'), join(stage, 'tools/libredwg'), { recursive: true });
const seed = JSON.parse(await readFile(join(root, 'examples/open-source/database.seed.json'), 'utf8'));
const showcases = JSON.parse(await readFile(join(root, 'examples/open-source/showcases.seed.json'), 'utf8'));
seed.scenes = showcases.scenes; seed.applications = showcases.applications;
await mkdir(join(stage, 'examples'));
await writeFile(join(stage, 'examples/database.seed.json'), JSON.stringify(seed));
await writeFile(join(stage, 'package.json'), JSON.stringify({ name: 'deepmonkey-studio-runtime', version: '0.2.0', private: true, type: 'module',
  workspaces: ['apps/api', ...[...chosen].map(name => packages.get(name).path)], overrides: lock.overrides }, null, 2));
for (const name of ['LICENSE', 'LICENSE.zh-CN.md', 'THIRD_PARTY_NOTICES.md']) await cp(join(root, name), join(stage, name));
}
const archive = join(output, 'DeepMonkey-Studio-Node-0.2.0.tar.gz');
await run('tar', ['--exclude=node_modules', '-czf', archive, '-C', stage, '.'], { maxBuffer: 1024 ** 2 });
const data = await readFile(archive);
const manifest = { schemaVersion: 1, version: '0.2.0', url: 'https://github.com/fatasia/DeepMonkey-Studio/releases/download/v0.2.0/DeepMonkey-Studio-Node-0.2.0.tar.gz',
  bytes: data.length, sha256: createHash('sha256').update(data).digest('hex'), node: '>=24', workspacePackages: JSON.parse(await readFile(join(stage, 'package.json'), 'utf8')).workspaces.length - 1 };
await writeFile(join(output, 'runtime-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(JSON.stringify(manifest));
