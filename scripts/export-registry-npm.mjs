import { cp, mkdir, readFile, writeFile, readdir, stat } from 'node:fs/promises';
import { resolve, join, relative, dirname } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';

const run = promisify(execFile), root = resolve(import.meta.dirname, '..');
const output = resolve(process.argv[2] ?? 'artifacts/releases/0.2.0/registry');
const version = '0.2.0';
const sdkVersion = '0.2.3';
await mkdir(output, { recursive: true });
const source = join(output, 'sdk-source');
await mkdir(source, { recursive: true });
await run('tar', ['-xzf', join(root, 'artifacts/releases/0.2.0/DeepMonkey-Studio-SDK-0.2.0.tar.gz'), '-C', source]);
const sdk = join(output, 'deepmonkey');
await mkdir(sdk, { recursive: true });
await run('tar', ['-xzf', join(source, `bim-studio-deep-engine-${version}.tgz`), '--strip-components=1', '-C', sdk]);
const manifest = JSON.parse(await readFile(join(sdk, 'package.json'), 'utf8'));
manifest.name = 'deepmonkey'; manifest.version = sdkVersion; manifest.private = false; manifest.license = 'SEE LICENSE IN LICENSE';
manifest.files = ['dist', 'bin', 'runtime-manifest.json', 'README.md', 'LICENSE', 'LICENSE.zh-CN.md', 'THIRD_PARTY_NOTICES.md'];
manifest.bin = { deepmonkey: 'bin/studio.mjs' }; manifest.engines = { node: '>=24' };
delete manifest.scripts; delete manifest.devDependencies;
for (const [key, value] of Object.entries(manifest.exports)) { delete value.development; if (!Object.keys(value).length) delete manifest.exports[key]; }
manifest.publishConfig = { access: 'public', registry: 'https://registry.npmjs.org' };
await writeFile(join(sdk, 'package.json'), JSON.stringify(manifest, null, 2));
await cp(join(root, 'packages/deep-engine/README.npm.md'), join(sdk, 'README.md'));
await cp(join(root, 'packages/studio-launcher/bin'), join(sdk, 'bin'), { recursive: true });
await cp(join(root, 'apps/desktop/src-tauri/icons/icon.ico'), join(sdk, 'bin/studio.ico'));
await cp(resolve(process.argv[3] ?? 'artifacts/releases/0.2.0/node-runtime-final/runtime-manifest.json'), join(sdk, 'runtime-manifest.json'));
for (const name of ['LICENSE', 'LICENSE.zh-CN.md', 'THIRD_PARTY_NOTICES.md']) await cp(join(root, name), join(sdk, name));
async function pack(directory) {
  const npm = process.env.npm_execpath?.endsWith('.js') ? process.env.npm_execpath : join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
  const result = await run(process.execPath, [npm, 'pack', '--json', '--pack-destination', output], { cwd: directory, maxBuffer: 8 * 1024 ** 2 });
  const item = JSON.parse(result.stdout)[0];
  console.log(JSON.stringify({ name: item.name, file: item.filename, bytes: item.size, unpackedBytes: item.unpackedSize }));
  return join(output, item.filename);
}
const engineArchive = await pack(sdk);
const creator = join(output, 'create-deepmonkey');
await cp(join(root, 'packages/create-deepmonkey'), creator, { recursive: true, filter: file => !file.split(/[\\/]/).includes('payload') });
const creatorManifest = JSON.parse(await readFile(join(creator, 'package.json'), 'utf8'));
creatorManifest.private = false; creatorManifest.license = 'SEE LICENSE IN LICENSE';
creatorManifest.publishConfig = { access: 'public', registry: 'https://registry.npmjs.org' };
await writeFile(join(creator, 'package.json'), JSON.stringify(creatorManifest, null, 2));
const payload = join(creator, 'payload');
await cp(join(root, 'packages/create-deepmonkey/starter'), payload, { recursive: true });
await cp(join(source, 'templates'), join(payload, 'templates'), { recursive: true });
await cp(join(root, 'apps/web/src/styles/base.css'), join(payload, 'tokens.css'));
for (const client of ['.agents', '.claude']) await cp(join(root, client, 'skills/deep-engine-3d'), join(payload, client, 'skills/deep-engine-3d'), { recursive: true });
await mkdir(join(payload, 'vendor'));
await cp(engineArchive, join(payload, `vendor/deepmonkey-${sdkVersion}.tgz`));
for (const name of ['fflate-0.8.3.tgz', 'webgpu-types-0.1.72.tgz']) await cp(join(source, name), join(payload, 'vendor', name));
async function rewrite(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = join(directory, entry.name);
    if (entry.isDirectory()) { if (entry.name !== 'vendor') await rewrite(file); }
    else if (/\.(ts|json|md)$/.test(file)) {
      const text = await readFile(file, 'utf8');
      let rewritten = text.replaceAll('@bim-studio/deep-engine', 'deepmonkey');
      if (entry.name === 'sdk-versions.json') rewritten = rewritten.replace('"deepmonkey": "0.2.0"', `"deepmonkey": "${sdkVersion}"`);
      if (entry.name === 'SKILL.md') {
        rewritten = rewritten.replace('"deepmonkey": "0.2.0"', `"deepmonkey": "${sdkVersion}"`);
        rewritten = rewritten.replace(/`@bim-studio\/\*` 当前通过[^\n]+/, '`deepmonkey` 从 npm 安装；生成项目已携带固定版本的 SDK 和依赖归档，直接运行 `npm run dev`、`npm run build`。仓库工作流命令仅适用于源码仓库；在生成项目中使用本地 npm 命令和浏览器截图验证。');
      }
      await writeFile(file, rewritten);
    }
  }
}
await rewrite(payload);
for (const name of ['LICENSE', 'LICENSE.zh-CN.md', 'THIRD_PARTY_NOTICES.md']) await cp(join(root, name), join(creator, name));
const creatorArchive = await pack(creator);
const launcher = join(output, 'deepmonkey-studio');
await cp(join(root, 'packages/studio-launcher'), launcher, { recursive: true });
await cp(join(root, 'apps/desktop/src-tauri/icons/icon.ico'), join(launcher, 'bin/studio.ico'));
const launcherManifest = JSON.parse(await readFile(join(launcher, 'package.json'), 'utf8'));
launcherManifest.private = false; launcherManifest.license = 'SEE LICENSE IN LICENSE';
await writeFile(join(launcher, 'package.json'), JSON.stringify(launcherManifest, null, 2));
await cp(join(sdk, 'runtime-manifest.json'), join(launcher, 'runtime-manifest.json'));
for (const name of ['LICENSE', 'LICENSE.zh-CN.md', 'THIRD_PARTY_NOTICES.md']) await cp(join(root, name), join(launcher, name));
const launcherArchive = await pack(launcher);
const files = [engineArchive, creatorArchive, launcherArchive];
const report = [];
for (const file of files) { const data = await readFile(file); report.push({ file: relative(output, file), bytes: (await stat(file)).size, sha256: createHash('sha256').update(data).digest('hex') }); }
await writeFile(join(output, 'npm-manifest.json'), JSON.stringify({ version, artifacts: report }, null, 2) + '\n');
