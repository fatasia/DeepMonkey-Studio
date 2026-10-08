import { mkdir, cp, readFile, writeFile } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile), root = resolve(import.meta.dirname, '..');
const output = resolve(process.argv[2]), baseManifest = resolve(process.argv[3]);
const name = 'deepmonkey-studio-client-win32-x64', version = '0.2.0';
const stage = join(output, 'stage'), pkg = join(output, name);
await mkdir(join(stage, 'publication/webview'), { recursive: true });
await mkdir(pkg, { recursive: true });
await cp(join(root, 'apps/desktop/src-tauri/target/release/bim-studio-desktop.exe'), join(stage, 'publication/webview/scene-viewer.exe'));
await run('tar', ['-czf', join(pkg, 'runtime.tar.gz'), '-C', stage, 'publication']);
const payload = await readFile(join(pkg, 'runtime.tar.gz'));
await writeFile(join(pkg, 'package.json'), JSON.stringify({ name, version,
  description: 'Windows WebView client exporter for DeepMonkey Studio',
  repository: { type: 'git', url: 'git+https://github.com/fatasia/DeepMonkey-Studio.git' },
  license: 'SEE LICENSE IN LICENSE', files: ['runtime.tar.gz', 'README.md', 'LICENSE', 'LICENSE.zh-CN.md', 'THIRD_PARTY_NOTICES.md'],
  publishConfig: { access: 'public', registry: 'https://registry.npmjs.org' } }, null, 2));
await writeFile(join(pkg, 'README.md'), '# DeepMonkey Studio Windows client exporter\n\nInstalled automatically by `npx deepmonkey@latest` on Windows x64. Exports published scenes as standalone WebView clients without Rust or build tools.\n\n[Studio documentation](https://github.com/fatasia/DeepMonkey-Studio)\n');
for (const file of ['LICENSE', 'LICENSE.zh-CN.md', 'THIRD_PARTY_NOTICES.md']) await cp(join(root, file), join(pkg, file));
const npm = join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
const packed = await run(process.execPath, [npm, 'pack', '--json', '--pack-destination', output], { cwd: pkg });
console.log(packed.stdout);
const manifest = JSON.parse(await readFile(baseManifest, 'utf8'));
const platform = manifest.platforms['win32-x64'];
platform.npmPackages.push({ package: `${name}@${version}`, bytes: payload.length, sha256: createHash('sha256').update(payload).digest('hex') });
platform.bytes = platform.npmPackages.reduce((total, item) => total + item.bytes, 0);
platform.sha256 = createHash('sha256').update(platform.npmPackages.map(item => item.sha256).join(':')).digest('hex');
await writeFile(join(output, 'runtime-manifest.json'), JSON.stringify(manifest, null, 2));
