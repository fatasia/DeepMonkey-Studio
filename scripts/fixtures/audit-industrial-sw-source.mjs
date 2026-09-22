import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const source = path.join(root, 'data/external-assets/industrial-format-plan/dependencies/extracted/cadmpeg-v0.6.0');
const output = path.join(root, 'test-output/industrial-solidworks/qualification-20260918');
const args = ['metadata', '--format-version', '1', '--offline', '--locked', '--no-default-features', '--features', 'cadmpeg/sldprt', '--filter-platform', 'x86_64-pc-windows-msvc'];
const run = spawnSync('cargo', args, { cwd: source, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
if (run.status !== 0) throw new Error(run.stderr);
const metadata = JSON.parse(run.stdout), packages = new Map(metadata.packages.map(p => [p.id, p]));
const nodes = new Map(metadata.resolve.nodes.map(n => [n.id, n]));
const main = metadata.packages.find(p => p.name === 'cadmpeg' && !p.source);
const visited = new Set();
function visit(id) {
  if (visited.has(id)) return;
  visited.add(id);
  for (const dep of nodes.get(id).deps) if (dep.dep_kinds.some(k => k.kind !== 'dev')) visit(dep.pkg);
}
visit(main.id);
const records = [];
for (const id of [...visited].sort()) {
  const p = packages.get(id), directory = path.dirname(p.manifest_path);
  const licenses = [];
  const allFiles = await walk(directory);
  for (const file of allFiles) if (/^(license|copying|notice|copyright)([._-]|$)/i.test(path.basename(file))) licenses.push(await describe(file, directory));
  const files = [];
  if (!p.source) {
    for (const file of allFiles) {
      const relative = path.relative(directory, file).replaceAll('\\', '/');
      if (!relative.startsWith('src/') && relative !== 'build.rs' && relative !== 'Cargo.toml') continue;
      const record = await describe(file, directory);
      if (/\.(rs|toml)$/.test(file)) record.spdx = (await readFile(file, 'utf8')).match(/SPDX-License-Identifier:\s*([^\r\n]+)/)?.[1] ?? null;
      files.push(record);
    }
  }
  records.push({ name: p.name, version: p.version, source: p.source ?? 'fixed upstream archive v0.6.0', license: p.license,
    licenseFile: p.license_file, features: nodes.get(id).features, notices: licenses, files,
    review: !p.license || files.some(f => f.spdx === null) ? 'review-required' : 'license-identifiers-present; not a legal clearance' });
}
const inventory = { schemaVersion: 1, scope: 'Windows sldprt CLI non-dev dependency closure; source headers and hashes, not provenance certification',
  metadataCommand: ['cargo', ...args].join(' '), cargoLock: await describe(path.join(source, 'Cargo.lock'), source),
  archive: await describe(path.join(source, '../../cadmpeg-v0.6.0.tar.gz'), path.join(source, '../..')),
  upstreamNotices: await Promise.all(['LICENSE', 'LICENSE-docs', 'LEGAL.md'].map(f => describe(path.join(source, f), source))),
  packages: records };
await mkdir(output, { recursive: true });
await writeFile(path.join(output, 'source-license-inventory.json'), JSON.stringify(inventory, null, 2));
console.log(JSON.stringify({ packages: records.length, sourceFiles: records.reduce((n, p) => n + p.files.length, 0),
  reviewRequired: records.filter(p => p.review === 'review-required').map(p => p.name), licenses: [...new Set(records.map(p => p.license))] }, null, 2));
async function describe(file, directory) {
  const bytes = await readFile(file);
  return { path: path.relative(directory, file).replaceAll('\\', '/'), bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
}
async function walk(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === 'target') continue;
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walk(file));
    else if (entry.isFile()) files.push(file);
  }
  return files;
}
