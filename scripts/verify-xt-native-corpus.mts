import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { auditGlbGeometry } from '../apps/api/src/converterOutputAudit.js';

// Research evidence only. No output from this runner is published as a ready model.
const execute = promisify(execFile);
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
// Source metres are lowered to scene millimetres before tessellation. Keep
// half of the fixed 0.01 mm witness budget for tessellation, not model-relative.
const tessellation = { unit: 'mm', absoluteSag: 0.005, quality: 'plain' } as const;
const [binaryArg, corpusArg, inventoryArg, outputArg] = process.argv.slice(2);
if (!binaryArg || !corpusArg || !inventoryArg || !outputArg) {
  throw new Error('Usage: verify-xt-native-corpus <exe> <corpus> <inventory.json> <output-directory>');
}
const binary = await realpath(binaryArg), corpus = await realpath(corpusArg);
const binarySha256 = sha256(await readFile(binary));
const inventoryBytes = await readFile(inventoryArg);
const inventory = JSON.parse(inventoryBytes.toString('utf8')) as {
  files: { path: string; sha256: string }[];
};
if (!Array.isArray(inventory.files) || !inventory.files.length || inventory.files.length > 10_000) {
  throw new Error('Corpus must contain 1..10000 files');
}
const outputDirectory = path.resolve(outputArg);
await mkdir(outputDirectory, { recursive: true });
const attemptDirectory = await mkdtemp(path.join(outputDirectory, 'attempt-'));
const results: Record<string, unknown>[] = [];
for (const [index, item] of inventory.files.entries()) {
  if (!item || typeof item.path !== 'string' || !/^[a-f0-9]{64}$/.test(item.sha256)) {
    throw new Error(`Invalid inventory row ${index}`);
  }
  const source = await realpath(path.resolve(corpus, item.path));
  const relative = path.relative(corpus, source);
  if (path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) {
    throw new Error(`Corpus path escapes source root: ${item.path}`);
  }
  if (sha256(await readFile(source)) !== item.sha256) throw new Error(`Source changed: ${item.path}`);
  const output = path.join(attemptDirectory, `${index}-${item.sha256.slice(0, 12)}.glb`);
  const started = performance.now();
  try {
    const { stdout, stderr } = await execute(binary, [source, output, '--quality', tessellation.quality,
      '--sag', String(tessellation.absoluteSag)], {
      timeout: 60_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true,
    });
    const geometry = await auditGlbGeometry(output);
    const match = stdout.match(/(\d+) bodies, (\d+)\/(\d+) faces, (\d+) triangles/);
    const reported = match ? {
      bodies: Number(match[1]), meshedFaces: Number(match[2]), faces: Number(match[3]),
      triangles: Number(match[4]),
    } : undefined;
    const countsAgree = reported !== undefined && reported.faces > 0
      && reported.meshedFaces === reported.faces && reported.triangles === geometry.triangleCount;
    const outputBytes = await readFile(output);
    results.push({ source: item.path, sourceSha256: item.sha256, status: 'preview-evidence',
      conversionAndAuditMs: performance.now() - started, outputBytes: outputBytes.byteLength,
      geometry, reported, countsAgree, diagnostics: stderr.trim(),
      output: path.relative(outputDirectory, output), outputSha256: sha256(outputBytes),
    });
  } catch (error) {
    const failure = error as Error & { code?: unknown; stdout?: string; stderr?: string; killed?: boolean };
    results.push({ source: item.path, sourceSha256: item.sha256, status: 'failed',
      conversionAndAuditMs: performance.now() - started,
      error: failure.message, code: failure.code, killed: failure.killed ?? false,
      diagnostics: failure.stderr ?? '',
    });
  }
  console.log(`${index + 1}/${inventory.files.length} ${results.at(-1)!.status}: ${item.path}`);
}
const summary = {
  total: results.length,
  previewEvidence: results.filter(row => row.status === 'preview-evidence').length,
  failed: results.filter(row => row.status === 'failed').length,
  reportedCountsAgree: results.filter(row => row.countsAgree === true).length,
  productionProfilesCertified: 0,
};
if (sha256(await readFile(binary)) !== binarySha256) throw new Error('Converter changed during evaluation');
await writeFile(path.join(outputDirectory, 'evidence.json'), JSON.stringify({
  schemaVersion: 1, scope: 'local-native-conversion-experiment',
  binarySha256, inventorySha256: sha256(inventoryBytes),
  tessellation,
  summary, results,
}, null, 2) + '\n');
console.log(JSON.stringify(summary));
