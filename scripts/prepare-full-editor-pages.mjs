import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { resolve, relative, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const [outputArg, originArg, base = '/DeepMonkey-Studio/'] = process.argv.slice(2);
if (!outputArg || !originArg) throw new Error('Usage: node scripts/prepare-full-editor-pages.mjs <new output> <api origin> [base]');
const api = originArg === '-' ? undefined : new URL(originArg);
if (api && (!['http:', 'https:'].includes(api.protocol) || api.username || api.password || api.pathname !== '/' || api.search || api.hash)) throw new Error('API must be a credential-free HTTP(S) origin');
if (!/^\/(?:[^/?#\\]+\/)+$/.test(base)) throw new Error('A trailing-slash website subpath is required');
const output = resolve(outputArg);
const inRepo = relative(root, output).replaceAll('\\', '/');
if (!inRepo.startsWith('../') && !/^(?:test-output|deliverables)\//.test(inRepo)) throw new Error('Within the repository, use a new test-output or deliverables directory');
const protectedPaths = ['apps/web/dist', 'apps/web/public', 'packages/deep-engine/dist'].map(path => resolve(root, path));
if (protectedPaths.some(path => !relative(path, output).startsWith('..'))) throw new Error('Use an isolated output outside production/public directories');
await mkdir(output, { recursive: true });
if ((await readdir(output)).length) throw new Error('Output is not empty; choose a new directory');
const cli = join(root, 'apps/web/node_modules/vite/bin/vite.js');
const build = spawnSync(process.execPath, [cli, 'build', '--base', base], { cwd: join(root, 'apps/web'), encoding: 'utf8', maxBuffer: 4 * 1024 ** 2,
  env: { ...process.env, VITE_STUDIO_API_ORIGIN: api?.origin ?? '', VITE_STUDIO_EDITOR_OUT_DIR: output, VITE_SCENE_VIEWER_BUILD: 'false' } });
await writeFile(`${output}.build.log`, `${build.stdout ?? ''}\n${build.stderr ?? ''}`);
if (build.status !== 0) throw new Error(`Isolated editor build failed: ${build.status}; see ${output}.build.log`);
const prune = spawnSync(process.execPath, [join(root, 'apps/web/scripts/prune-dist-dev.mjs'), output], { cwd: root, stdio: 'inherit' });
if (prune.status !== 0) throw new Error('Isolated development assets prune failed');
let html = await readFile(join(output, 'index.html'), 'utf8');
// Meta is an editable non-secret runtime override; API credentials never enter this build.
html = html.replace('</head>', `<meta name="studio-api-origin" content="${api?.origin ?? ''}">\n</head>`);
await writeFile(join(output, 'index.html'), html);
await writeFile(join(output, '404.html'), html);
await writeFile(join(output, '.nojekyll'), '');
await writeFile(join(output, 'editor-hosting.json'), JSON.stringify({ kind: 'complete-editor', base, apiOrigin: api?.origin ?? null,
  productionDeployment: api ? 'api-configured-pending-live-verification' : 'frontend-only-api-unconfigured', version: '0.2.0' }, null, 2));
console.log(JSON.stringify({ output, base, apiOrigin: api?.origin ?? null, published: false }, null, 2));
