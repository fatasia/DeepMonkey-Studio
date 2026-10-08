import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';

const [stageArg, outputArg, frozenArg, base = '/DeepMonkey-Studio/', cameraArg] = process.argv.slice(2);
if (!stageArg || !outputArg || !frozenArg || !/^\/[A-Za-z0-9_/-]+\/$/.test(base)) throw Error('Usage: <SMT viewer frontend> <new demo directory> <frozen export directory> [Pages base]');
const stage = resolve(stageArg), output = resolve(outputArg), frozen = resolve(frozenArg);
await mkdir(output, { recursive: true });
const manifest = JSON.parse(await readFile(join(stage, 'delivery/scene-viewer.json'), 'utf8'));
const dependencies = JSON.parse(await readFile(join(frozen, 'dependencies.json'), 'utf8'));
if (manifest.publication.sceneId !== dependencies.sceneId) throw Error('Frozen SMT scene identity mismatch');
const rebase = value => {
  if (typeof value === 'string') return value.startsWith('/delivery/') ? `${base}demo/${value.slice('/delivery/'.length)}` : value;
  if (Array.isArray(value)) return value.map(rebase);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, rebase(v)]));
  return value;
};
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const files = [];
for (const asset of manifest.assets) {
  const relative = asset.localUrl.slice('/delivery/'.length);
  if (relative.includes('..') || !asset.localUrl.startsWith('/delivery/')) throw Error('Unsafe frozen path');
  const bytes = await readFile(join(stage, 'delivery', relative));
  if (sha(bytes) !== asset.sha256.toLowerCase()) throw Error('Frozen resource digest mismatch');
  await mkdir(join(output, relative, '..'), { recursive: true });
  await writeFile(join(output, relative), bytes);
  files.push({ path: relative, bytes: bytes.length, sha256: sha(bytes) });
}
const project = rebase(manifest.project), scene = rebase(manifest.publication.snapshot);
project.name = 'SMT 示例工程'; project.description = '浏览器本地体验；编辑保存在当前浏览器。';
scene.name = 'SMT 产线'; delete scene.publishedAt;
const applications = dependencies.inputs.applications.filter(x => x.metadata.id === scene.id).map(rebase);
for (const app of applications) app.metadata.name = scene.name;
if (cameraArg) {
  const camera = JSON.parse(await readFile(resolve(cameraArg), 'utf8'));
  if (![camera.position, camera.target].every(point => point && ['x', 'y', 'z'].every(axis => Number.isFinite(point[axis])))) throw Error('Invalid demo camera');
  scene.camera = camera;
  for (const app of applications) for (const snapshot of app.scenes) if (snapshot.id === scene.id) snapshot.camera = camera;
}
const origin = process.env.BIM_QA_API_ORIGIN ?? 'http://127.0.0.1:4100';
if (!['localhost', '127.0.0.1'].includes(new URL(origin).hostname)) throw Error('Resource export requires loopback API');
const login = await fetch(`${origin}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ username: process.env.BIM_QA_USER ?? 'admin', password: process.env.BIM_QA_PASSWORD ?? 'admin' }) });
if (!login.ok) throw Error(`Login HTTP ${login.status}`);
const { token } = await login.json(), headers = { authorization: `Bearer ${token}` };
const json = async path => { const response = await fetch(origin + path, { headers, signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw Error(`${path}: HTTP ${response.status}`); return response.json(); };
const first = await json('/api/asset-library?pageSize=100&featured=true');
const candidates = [...first.items];
for (let page = 2; page <= first.totalPages; page++) candidates.push(...(await json(`/api/asset-library?pageSize=100&featured=true&page=${page}`)).items);
const library = [], skipped = [], budget = 650 * 1024 ** 2;
const dimensionBudgets = { '3d': 440 * 1024 ** 2, environment: 110 * 1024 ** 2, material: 90 * 1024 ** 2 };
const dimensionBytes = { '3d': 0, environment: 0, material: 0 };
let totalBytes = files.reduce((sum, file) => sum + file.bytes, 0);
const cached = new Map();
async function download(path, expectedHash) {
  if (!path.startsWith('/api/') || path.includes('..')) throw Error('Only API-owned resource paths may be exported');
  if (cached.has(path)) return cached.get(path);
  const response = await fetch(origin + path, { headers, signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw Error(`Resource HTTP ${response.status}: ${path}`);
  const bytes = Buffer.from(await response.arrayBuffer()), digest = sha(bytes);
  if (expectedHash && digest !== expectedHash.toLowerCase()) throw Error(`Resource digest mismatch: ${path}`);
  const type = response.headers.get('content-type') ?? '';
  const extension = /png/.test(type) ? '.png' : /jpeg/.test(type) ? '.jpg' : /gltf-binary/.test(type) ? '.glb' : /exr/.test(type) ? '.exr' : '.bin';
  const relative = `library/${digest}${extension}`;
  await mkdir(join(output, 'library'), { recursive: true }); await writeFile(join(output, relative), bytes);
  const record = { path: relative, bytes: bytes.length, sha256: digest }; files.push(record); totalBytes += bytes.length;
  const result = { url: `${base}demo/${relative}`, ...record }; cached.set(path, result); return result;
}
for (const item of candidates) {
  if (totalBytes + item.size * 1.1 > budget || dimensionBytes[item.dimension] + item.size * 1.1 > dimensionBudgets[item.dimension]) { skipped.push(item.id); continue; }
  const bytesBefore = totalBytes;
  const maps = item.dimension === '3d' ? [] : await json(`/api/asset-library/items/${encodeURIComponent(item.id)}/maps`);
  const thumbnail = await download(item.thumbnailUrl);
  const frozenMaps = [];
  for (const map of maps) { const file = await download(map.url, map.contentHash); frozenMaps.push({ ...map, url: file.url }); }
  const preview = item.dimension === '3d' ? await download(item.previewUrl, item.contentHash) : (frozenMaps[0] ? { url: frozenMaps[0].url } : thumbnail);
  library.push({ item: { ...item, thumbnailUrl: thumbnail.url, previewUrl: preview.url }, maps: frozenMaps });
  dimensionBytes[item.dimension] += totalBytes - bytesBefore;
  if (library.length % 50 === 0) console.log(`Exported ${library.length}/${candidates.length} assets (${(totalBytes / 1024 ** 2).toFixed(1)} MiB)`);
}
const sensorData = await json('/api/demo/sensors');
const sensorRows = Array.isArray(sensorData) ? sensorData : sensorData.items;
if (!Array.isArray(sensorRows)) throw Error('Demo sensor data must be rows');
const now = new Date().toISOString();
const connectionId = 'pages-demo-sensors';
project.dataConnections = [{ id: connectionId, projectId: project.id, name: '内置演示数据', type: 'http', enabled: true,
  config: { url: '/api/demo/sensors', format: 'json' }, createdAt: now, updatedAt: now }];
project.datasets = [{ id: 'pages-demo-telemetry', projectId: project.id, connectionId, name: '设备遥测示例',
  sourceKey: '/api/demo/sensors', refreshSeconds: 15, fields: [
    { key: 'recorded_at', label: '时间', type: 'datetime' }, { key: 'device_id', label: '设备', type: 'string' },
    { key: 'temperature', label: '温度', type: 'number', unit: '°C' }, { key: 'pressure', label: '压力', type: 'number' },
    { key: 'running', label: '运行中', type: 'boolean' }], createdAt: now, updatedAt: now }];
await writeFile(join(output, 'workspace.json'), JSON.stringify({ schemaVersion: 1,
  state: { schemaVersion: 1, projects: [project], scenes: [scene], applications, scenePublications: [], applicationPublications: [] },
  library, sensorRows, defaultPath: applications.length ? `/studio/${project.id}/applications/${scene.id}/scenes/${scene.id}` : `/scene/${scene.id}` }));
await writeFile(join(output, 'resources.json'), JSON.stringify({ schemaVersion: 1, sourcePublicationSha256: manifest.sourcePublicationSha256,
  libraryItems: library.length, candidateItems: candidates.length, totalBytes, skippedForSizeBudget: skipped, sensorRows: sensorRows.length, files }, null, 2));
console.log(JSON.stringify({ output, libraryItems: library.length, totalBytes, applications: applications.length, sensorRows: sensorRows.length }));
