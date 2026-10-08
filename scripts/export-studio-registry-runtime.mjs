import { mkdir, readFile, writeFile, cp } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile), root = resolve(import.meta.dirname, '..');
const source = resolve(process.argv[2] ?? 'artifacts/releases/0.2.0/node-runtime-final/runtime');
const output = resolve(process.argv[3] ?? 'artifacts/releases/0.2.0/npm-runtime');
const version = '0.2.1', npm = join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
await mkdir(output, { recursive: true });
const components = [
  { name: 'deepmonkey-studio-runtime', entries: ['apps', 'packages', 'examples', 'scripts', 'package.json', 'package-lock.json', 'LICENSE', 'LICENSE.zh-CN.md', 'THIRD_PARTY_NOTICES.md'], platform: false },
  { name: 'deepmonkey-studio-runtime-win32-x64', entries: ['node_modules', 'publication', 'tools'], platform: true },
];
const records = [];
for (const component of components) {
  const directory = join(output, component.name); await mkdir(directory, { recursive: true });
  const archive = join(directory, 'runtime.tar.gz');
  await run('tar', ['--exclude=*.br', '--exclude=*.gz', '-czf', archive, '-C', source, ...component.entries], { windowsHide: true, maxBuffer: 2 * 1024 ** 2 });
  const hash = createHash('sha256'); let bytes = 0;
  for await (const chunk of createReadStream(archive)) { bytes += chunk.length; hash.update(chunk); }
  const sha256 = hash.digest('hex');
  await writeFile(join(directory, 'package.json'), JSON.stringify({ name: component.name, version, description: component.platform ? 'Windows x64 runtime dependencies and native tools for DeepMonkey Studio' : 'Web editor and API runtime for DeepMonkey Studio',
    license: 'SEE LICENSE IN LICENSE', files: ['runtime.tar.gz', 'LICENSE', 'LICENSE.zh-CN.md', 'THIRD_PARTY_NOTICES.md', 'README.md'],
    repository: { type: 'git', url: 'git+https://github.com/fatasia/DeepMonkey-Studio.git' }, engines: { node: '>=24' }, publishConfig: { access: 'public', registry: 'https://registry.npmjs.org' } }, null, 2));
  await writeFile(join(directory, 'README.md'), `# ${component.name}\n\nRuntime component of [DeepMonkey Studio](https://github.com/fatasia/DeepMonkey-Studio).\n\nStart the editor with Node.js 24+:\n\n\`\`\`sh\nnpx deepmonkey@latest\n\`\`\`\n\nThe launcher installs the matching runtime through your configured npm registry and caches it locally. This package is managed by the launcher.\n\n${component.platform ? 'Includes Windows x64 dependencies, the native renderer and DWG tools.' : 'Includes the Web editor, API, sample project and shared runtime packages.'}\n\nAI providers, external databases and cloud rendering require their respective service configuration.\n`);
  for (const name of ['LICENSE', 'LICENSE.zh-CN.md', 'THIRD_PARTY_NOTICES.md']) await cp(join(root, name), join(directory, name));
  const packed = await run(process.execPath, [npm, 'pack', '--json', '--pack-destination', output], { cwd: directory, windowsHide: true, maxBuffer: 2 * 1024 ** 2 });
  const info = JSON.parse(packed.stdout)[0];
  records.push({ package: `${component.name}@${version}`, sha256, bytes });
  console.log(JSON.stringify({ package: component.name, bytes: info.size, payload: bytes }));
}
const legacy = JSON.parse(await readFile(join(source, '../runtime-manifest.json'), 'utf8'));
const core = records[0], platform = records[1];
// Other platforms retain npm's native dependency installation for their own OS/architecture.
const base = { ...legacy, npmPackages: [core], sha256: core.sha256, bytes: core.bytes };
base.platforms = { 'win32-x64': { npmPackages: records, sha256: createHash('sha256').update(records.map(x => x.sha256).join(':')).digest('hex'), bytes: core.bytes + platform.bytes, dependenciesInstalled: true } };
await writeFile(join(output, 'runtime-manifest.json'), JSON.stringify(base, null, 2));
