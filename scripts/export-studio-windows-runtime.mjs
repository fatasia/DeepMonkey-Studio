import { readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { pruneRuntimePlatforms } from './prune-runtime-platforms.mjs';

if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Build on Windows x64');
const output = resolve(process.argv[2] ?? 'artifacts/releases/0.2.0/node-runtime-final');
const stage = join(output, 'runtime'), run = promisify(execFile);
const pruning = await pruneRuntimePlatforms(stage, 'win32', 'x64');
// The root npm lock and workspace links belong to the already-tested install.
// Dereference aliases so extraction does not require Windows symlink privileges.
const filename = 'DeepMonkey-Studio-Node-0.2.0-windows-x64.tar.gz';
await run('tar', ['-chzf', join(output, filename), '-C', stage, '.'], { maxBuffer: 1024 ** 2 });
const bytes = await readFile(join(output, filename));
const manifest = JSON.parse(await readFile(join(output, 'runtime-manifest.json'), 'utf8'));
manifest.platforms = { 'win32-x64': { url: `https://github.com/fatasia/DeepMonkey-Studio/releases/download/v0.2.0/${filename}`,
  bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), dependenciesInstalled: true } };
await writeFile(join(output, 'runtime-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(JSON.stringify({ archive: filename, bytes: bytes.length, removedPlatformBytes: pruning.removedBytes }));
