import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = process.cwd();
const base = path.join(root, 'data/external-assets/industrial-format-plan');
const executable = path.resolve(process.argv[2] ?? path.join(base, 'build-trial/e57-reader-cli/Release/e57-reader.exe'));
const output = path.resolve(process.argv[3] ?? 'test-output/industrial-e57-reader-20260918');
const sampleRoot = path.join(base, 'samples/extracted/libE57Format-test-data');
const digest = async (file) => createHash('sha256').update(await readFile(file)).digest('hex');
const archives = [
  ['dependencies/libE57Format-v3.4.0.tar.gz', 'e776c438d8075a538ad38a9f821c920694019cde6a2e6cc2e15bcbfb9116e54e'],
  ['dependencies/xerces-c-3.3.0.tar.gz', '9555f1d06f82987fbb4658862705515740414fd34b4db6ad2ed76a2dc08d3bde'],
  ['samples/libE57Format-test-data-main.tar.gz', '69382e0ab721b80708ce4fe4190921a9c290acb8fff69ede7e5d054a9b1fb404'],
];
for (const [file, hash] of archives) assert.equal(await digest(path.join(base, file)), hash, file);
const cases = [
  ['reference/bunnyDouble.e57', 30571, 1], ['reference/bunnyInt32.e57', 30571, 1],
  ['self/ColouredCubeDouble.e57', 7680, 1], ['self/ColouredCubeFloat.e57', 7680, 1],
  ['self/empty.e57', 0, 0], ['self/ZeroPoints.e57', 0, 1],
  ['self/测试点云.e57', 0, 0], ['self/test filename äöü.e57', 0, 0],
  ['self/ZeroPointsInvalid.e57', null], ['self/InvalidCVHeader.e57', null],
  ['self/InvalidFileLength.e57', null], ['self/bad-crc.e57', null], ['self/NoPrototype.e57', null],
];
const records = [];
for (const [file, points, scans] of cases) {
  const source = path.join(sampleRoot, file);
  const runs = [];
  for (let round = 0; round < 2; round++) {
    const run = spawnSync(executable, [source], { encoding: 'utf8', windowsHide: true, timeout: 30000, maxBuffer: 1024 * 1024 });
    assert.ifError(run.error);
    assert.equal(run.signal, null);
    assert.equal(run.status, points === null ? 1 : 0, `${file}: ${run.stderr}`);
    if (points === null) {
      assert.equal(run.stdout.trim(), '', 'rejected input must not emit success metadata');
      assert.match(run.stderr, /E57-rejected:|input-rejected:/);
      runs.push({ rejected: true, diagnostic: run.stderr.trim() });
    } else {
      const value = JSON.parse(run.stdout);
      assert.equal(value.points, points, file);
      assert.equal(value.scans.length, scans, file);
      assert.equal(value.validPoints + value.invalidPoints, value.points);
      assert.equal(value.chunkPoints, 4096);
      assert.equal(value.poseApplied, false);
      if (file.includes('ColouredCube')) assert.deepEqual(value.localBounds, [[-0.5, -0.5, -0.5], [0.5, 0.5, 0.5]]);
      runs.push(value);
    }
  }
  assert.deepEqual(runs[0], runs[1], `${file}: repeat mismatch`);
  records.push({ file, sha256: await digest(source), bytes: (await stat(source)).size, result: runs[0], rounds: 2 });
}
assert.deepEqual(records[0].result, records[1].result, 'double vs scaled-int bunny geometry');
assert.deepEqual(records[2].result, records[3].result, 'double vs float cube geometry');
await mkdir(output, { recursive: true });
await writeFile(path.join(output, 'evidence.json'), `${JSON.stringify({ schemaVersion: 1, status: 'qualification-only', productionImporter: false, executable: { path: executable, sha256: await digest(executable), bytes: (await stat(executable)).size }, archives, records }, null, 2)}\n`);
console.log(JSON.stringify({ passed: true, positive: 8, rejected: 5, rounds: 2, output }));
