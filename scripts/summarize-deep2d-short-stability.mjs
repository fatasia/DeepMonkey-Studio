import { readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'

const directory = resolve(process.argv[2] ?? '')
assert.ok(process.argv[2], 'Pass a short-stability evidence directory')
const conditions = JSON.parse((await readFile(join(directory, 'conditions.json'), 'utf8')).replace(/^\uFEFF/, ''))
const processSummary = JSON.parse((await readFile(join(directory, 'summary.json'), 'utf8')).replace(/^\uFEFF/, ''))
assert.equal(processSummary.exitCode, 0)
assert.equal(processSummary.timedOut, false)
const lines = (await readFile(join(directory, 'stdout.log'), 'utf8')).split(/\r?\n/)
const rows = new Map()
for (const line of lines) {
  if (!line.startsWith('{')) continue
  const row = JSON.parse(line)
  if (row.scenario === '__meta__') continue
  const key = `${row.round}:${row.scenario}`
  if (rows.has(key)) assert.deepEqual(rows.get(key), row, 'Repeated summary must match raw row')
  rows.set(key, row)
}
assert.equal(rows.size, conditions.rounds * 7)
const byScenario = new Map()
for (const row of rows.values()) {
  assert.equal(row.measurement_schema, 2)
  assert.equal(row.samples, 30)
  assert.equal(row.warmup, 5)
  assert.equal(row.raw_samples.length, 30)
  assert.ok(Number.isInteger(row.round) && row.round >= 0 && row.round < conditions.rounds)
  for (const sample of row.raw_samples) {
    for (const key of ['cpu_prepare_ms', 'present_delay_ms', 'gpu_frame_ms']) {
      assert.ok(sample[key] === null || (Number.isFinite(sample[key]) && sample[key] >= 0), key)
    }
  }
  if (row.scenario === 'static_repeat') {
    assert.equal(row.staged_frames, 0)
    assert.ok(row.raw_samples.every(sample => !sample.staged && sample.uploaded_bytes === 0))
  }
  const group = byScenario.get(row.scenario) ?? []
  group.push(row)
  byScenario.set(row.scenario, group)
}
const median = values => {
  const sorted = [...values].sort((a, b) => a - b)
  const index = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[index] : (sorted[index - 1] + sorted[index]) / 2
}
const scenarios = Object.fromEntries([...byScenario].map(([name, group]) => {
  assert.equal(group.length, conditions.rounds)
  return [name, {
    rounds: group.length,
    cpuP50MedianMs: median(group.map(row => row.cpu_prepare_p50_ms)),
    cpuP95MedianMs: median(group.map(row => row.cpu_prepare_p95_ms)),
    cpuP99WorstMs: Math.max(...group.map(row => row.cpu_prepare_p99_ms)),
    gpuP50MedianMs: group.every(row => row.gpu_frame_p50_ms !== null) ? median(group.map(row => row.gpu_frame_p50_ms)) : null,
    presentP50MedianMs: median(group.map(row => row.present_delay_p50_ms)),
    estimatedVramMinBytes: Math.min(...group.map(row => row.est_vram_peak_bytes)),
    estimatedVramMaxBytes: Math.max(...group.map(row => row.est_vram_peak_bytes)),
    uploadBytesPerStageMax: Math.max(...group.map(row => row.uploaded_bytes_avg_per_stage)),
  }]
}))
assert.equal(byScenario.size, 7)
assert.deepEqual([...byScenario.keys()].sort(), [
  'initial_build', 'static_repeat', 'local_update_one_series', 'full_replace',
  'resize_1280_960', 'legend_toggle', 'tooltip_text_update',
].sort())
const result = {
  schema: 2, rounds: conditions.rounds, renderedFrames: rows.size * 35,
  measuredFrames: rows.size * 30, process: processSummary, scenarios,
  limitation: 'Observed short-run resource peaks, not proof of leak freedom or cross-device performance. VRAM estimate excludes atlas/pipelines.',
}
await writeFile(join(directory, 'validated-results.json'), `${JSON.stringify(result, null, 2)}\n`)
console.log(JSON.stringify(result, null, 2))
