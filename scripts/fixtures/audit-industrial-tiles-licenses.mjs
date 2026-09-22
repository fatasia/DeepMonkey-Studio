import { createHash } from 'node:crypto';
import { readFile, readdir, realpath, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const requestedRoot = process.argv[3]?.startsWith('--') ? undefined : process.argv[3];
const root = path.resolve(requestedRoot ?? 'data/external-assets/industrial-format-plan/build-trial/3dtiles-renderer');
const output = path.resolve(process.argv[2] ?? 'test-output/industrial-tiles-licenses-20260918');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const packages = [], seen = new Set();
const supplementRoot = path.resolve('data/external-assets/industrial-format-plan/license-supplements');
const pmtilesLicense = {
  version: '4.4.1', commit: '0cebcaeade40034b86facb6e7da4ec726b9053fb',
  url: 'https://raw.githubusercontent.com/protomaps/PMTiles/0cebcaeade40034b86facb6e7da4ec726b9053fb/LICENSE',
  sha256: '0371c38f338835f7fc13ed71176f3d92144e22c8b736a31cced57adbbeb647b3',
};
if (process.argv.includes('--fetch-missing')) {
  const response = await fetch(pmtilesLicense.url);
  if (!response.ok) throw new Error(`Pinned PMTiles license download failed: ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (hash(bytes) !== pmtilesLicense.sha256) throw new Error('Pinned PMTiles license hash mismatch');
  await mkdir(supplementRoot, { recursive: true });
  await writeFile(path.join(supplementRoot, 'pmtiles-4.4.1-LICENSE'), bytes);
  await writeFile(path.join(supplementRoot, 'pmtiles-4.4.1-source.json'), JSON.stringify(pmtilesLicense, null, 2) + '\n');
}

async function dependencyDirectory(name, from) {
  let directory = from;
  while (directory === root || directory.startsWith(root + path.sep)) {
    const candidate = path.join(directory, 'node_modules', name);
    try { await readFile(path.join(candidate, 'package.json')); return candidate; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    directory = path.dirname(directory);
  }
  throw new Error(`Missing locked runtime dependency ${name} from ${from}`);
}

async function inspect(directory) {
  directory = await realpath(directory);
  if (seen.has(directory)) return;
  if (directory !== root && !directory.startsWith(root + path.sep)) throw new Error('Dependency escaped qualification tree');
  seen.add(directory);
  const packageBytes = await readFile(path.join(directory, 'package.json'));
  const pkg = JSON.parse(packageBytes);
  const files = [], notices = [], licenseMentions = [];
  async function walk(folder) {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      if (['node_modules', '.git'].includes(entry.name)) continue;
      const file = path.join(folder, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Linked source requires separate audit: ${file}`);
      if (entry.isDirectory()) await walk(file);
      else if (entry.isFile()) {
        const bytes = await readFile(file), relative = path.relative(directory, file).replaceAll('\\', '/');
        const record = { path: relative, bytes: bytes.length, sha256: hash(bytes) };
        files.push(record);
        if (/^(licen[cs]e|notice|copying|copyright)([.-]|$)/i.test(entry.name)) notices.push(record);
        if (/\.(?:[cm]?js|ts|tsx|jsx|c|h|cpp)$/i.test(entry.name)) {
          const header = bytes.subarray(0, 8192).toString('utf8');
          const mentions = header.match(/[^\r\n]*(?:SPDX-License-Identifier|@license|licensed under|copyright)[^\r\n]*/gi);
          if (mentions) licenseMentions.push({ path: relative, lines: mentions.map(line => line.slice(0, 240)) });
        }
      }
    }
  }
  await walk(directory);
  if (pkg.name === 'pmtiles' && pkg.version === pmtilesLicense.version) {
    try {
      const file = path.join(supplementRoot, 'pmtiles-4.4.1-LICENSE'), bytes = await readFile(file);
      if (hash(bytes) !== pmtilesLicense.sha256) throw new Error('PMTiles license supplement changed');
      notices.push({ path: file, bytes: bytes.length, sha256: hash(bytes), source: pmtilesLicense });
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  files.sort((a, b) => a.path.localeCompare(b.path, 'en'));
  packages.push({ name: pkg.name, version: pkg.version, declaredLicense: pkg.license ?? null,
    localQualificationManifest: directory === root && pkg.private === true,
    relativePath: path.relative(root, directory).replaceAll('\\', '/') || '.', packageSha256: hash(packageBytes),
    notices, licenseMentions, files, bytes: files.reduce((sum, file) => sum + file.bytes, 0),
    peerDependencies: pkg.peerDependencies ?? {}, optionalDependencies: pkg.optionalDependencies ?? {} });
  for (const name of Object.keys(pkg.dependencies ?? {}).sort()) await inspect(await dependencyDirectory(name, directory));
}

await inspect(root);
const missingNotices = packages.filter(pkg => !pkg.localQualificationManifest && !pkg.notices.length).map(pkg => `${pkg.name}@${pkg.version}`);
const evidence = { schemaVersion: 1, measuredAt: new Date().toISOString(),
  scope: 'Pinned source and declared production dependency file/license inventory; optional peers and renderer integration require separate qualification.',
  lockSha256: hash(await readFile(path.join(root, 'package-lock.json'))), packages, missingNotices,
  reviewStatus: 'inventory-complete; per-file exception review and redistribution notice assembly remain required' };
await mkdir(output, { recursive: true });
await writeFile(path.join(output, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n');
console.log(JSON.stringify({ packages: packages.map(pkg => ({ name: pkg.name, version: pkg.version,
  license: pkg.declaredLicense, files: pkg.files.length, notices: pkg.notices.length })), missingNotices, output }, null, 2));
if (missingNotices.length) process.exitCode = 1;
