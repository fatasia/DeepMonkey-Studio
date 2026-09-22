import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir, lstat, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../../', import.meta.url));
const vendor = path.join(root, 'data/external-assets/industrial-format-plan/dependencies/vendor/cadmpeg-v0.6.0');
const source = path.join(root, 'data/external-assets/industrial-format-plan/dependencies/extracted/cadmpeg-v0.6.0');
const output = path.join(root, 'test-output/industrial-solidworks/qualification-20260918/vendor-inventory.json');
const packages = [];
for (const entry of (await readdir(vendor, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
  assert(entry.isDirectory() && !entry.isSymbolicLink(), 'Unexpected vendored entry');
  const directory = path.join(vendor, entry.name);
  const manifest = JSON.parse(await readFile(path.join(directory, '.cargo-checksum.json'), 'utf8'));
  let totalBytes = 0;
  for (const [relative, sha256] of Object.entries(manifest.files)) {
    assert(!relative.includes('\\') && !path.isAbsolute(relative) && !relative.split('/').some(s => !s || s === '.' || s === '..'), 'Unsafe checksum path');
    const file = path.join(directory, relative);
    assert((await lstat(file)).isFile(), 'Checksum entry must be a regular file');
    const bytes = await readFile(file);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), sha256, `${entry.name}/${relative}`);
    totalBytes += bytes.length;
  }
  packages.push({ directory: entry.name, packageSha256: manifest.package, files: Object.keys(manifest.files).length, bytes: totalBytes,
    checksumManifestSha256: createHash('sha256').update(await readFile(path.join(directory, '.cargo-checksum.json'))).digest('hex') });
}
const config = ['--config', 'source.crates-io.replace-with="vendored-sources"', '--config', `source.vendored-sources.directory="${vendor.replaceAll('\\', '/')}"`];
const run = spawnSync('cargo', ['metadata', '--format-version', '1', '--offline', '--locked', '--no-default-features', '--features', 'cadmpeg/sldprt', ...config],
  { cwd: source, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
assert.equal(run.status, 0, run.stderr);
const metadata = JSON.parse(run.stdout);
const registryPackages = metadata.packages.filter(p => p.source);
assert(registryPackages.every(p => path.relative(vendor, p.manifest_path) && !path.relative(vendor, p.manifest_path).startsWith('..')), 'Cargo must resolve vendored source paths');
const inventory = { schemaVersion: 1, root: vendor, cargoConfigArguments: config, resolvedRegistryPackages: registryPackages.length,
  totalFiles: packages.reduce((n, p) => n + p.files, 0), totalBytes: packages.reduce((n, p) => n + p.bytes, 0), packages };
await writeFile(output, JSON.stringify(inventory, null, 2));
console.log(JSON.stringify({ packages: packages.length, files: inventory.totalFiles, bytes: inventory.totalBytes, offlineMetadata: 'passed' }));
