import { describe, expect, it, vi } from 'vitest';
import { PagesDemoApi, listPagesAssets, type PagesDemoManifest } from './pagesDemoApi';
import { createInitialWorkspaceState, type DesktopLocalWorkspaceState, type DesktopLocalWorkspaceStore } from './desktopLocalWorkspaceStore';
import type { AssetLibraryItem } from '@bim-studio/contracts';

class Store implements DesktopLocalWorkspaceStore {
  state = createInitialWorkspaceState();
  assets = new Map<string, Blob>();
  async read() { return structuredClone(this.state); }
  async write(value: DesktopLocalWorkspaceState) { this.state = structuredClone(value); }
  async readModelAsset(id: string) { return this.assets.get(id); }
  async writeModelAsset(id: string, blob: Blob) { this.assets.set(id, blob); }
  async deleteModelAsset(id: string) { this.assets.delete(id); }
  async readScriptDependency() { return undefined; }
  async writeScriptDependency() {}
  async deleteScriptDependency() {}
}
const item: AssetLibraryItem = { id: 'smt', name: 'SMT 产线', dimension: '3d', category: '工业', format: 'glb', size: 3,
  triangleCount: 1, meshCount: 1, materialCount: 1, textureCount: 0, animated: true, featured: true, qualityTier: 'light',
  thumbnailUrl: '/DeepMonkey-Studio/demo/smt.png', previewUrl: '/DeepMonkey-Studio/demo/smt.glb', tags: ['产线'],
  version: '1', license: 'sample', publicationStatus: 'published', contentHash: 'wrong' };
function seed(): PagesDemoManifest {
  const state = createInitialWorkspaceState();
  state.projects[0]!.name = 'SMT 示例';
  state.projects[0]!.datasets = [{ id: 'telemetry', projectId: 'local-project', connectionId: 'sensors', name: '设备遥测演示',
    sourceKey: '/api/demo/sensors', refreshSeconds: 15, fields: [{ key: 'temperature', type: 'number', label: '温度' }], createdAt: '', updatedAt: '' }];
  return { schemaVersion: 1, state, library: [{ item, maps: [] }], sensorRows: [{ temperature: 26 }], defaultPath: '/projects' };
}
describe('Pages browser workspace', () => {
  it.each([
    ['/api/cloud-render/capability', 'GET'],
    ['/api/projects/local-project/scenes/smt/native-candidates', 'POST'],
    ['/api/projects/local-project/scenes/smt/publications/1/dependencies', 'GET'],
    ['/api/projects/local-project/scenes/smt/publications/1/native-executable', 'POST'],
    ['/api/projects/local-project/data-endpoints', 'POST'],
  ])('reports the server requirement for %s without calling a remote API', async (path, method) => {
    vi.stubGlobal('window', { location: { origin: 'https://example.test' } });
    const transport = vi.fn(), api = new PagesDemoApi(seed(), new Store(), transport);
    await api.initialize();
    const response = await api.handle(path, { method, ...(method === 'POST' ? { body: '{}' } : {}) });
    expect(response.status).toBe(409);
    expect(transport).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
  it('seeds once, then preserves edits across runtime restarts', async () => {
    const store = new Store(), first = new PagesDemoApi(seed(), store);
    await first.initialize();
    expect(store.state.projects[0]!.name).toBe('SMT 示例');
    store.state.projects[0]!.name = '编辑后';
    await new PagesDemoApi(seed(), store).initialize();
    expect(store.state.projects[0]!.name).toBe('编辑后');
  });
  it('opens a connected SMT ontology and preserves edits with revision conflicts', async () => {
    vi.stubGlobal('window', { location: { origin: 'https://example.test' } });
    const store = new Store(), api = new PagesDemoApi(seed(), store); await api.initialize();
    const base = '/api/projects/local-project/ontology-packages';
    const [pkg] = await (await api.handle(base)).json();
    expect(pkg.objects).toHaveLength(4); expect(pkg.relations).toHaveLength(3);
    const graph = await (await api.handle(`${base}/${pkg.id}/graph`, { method: 'POST', body: JSON.stringify({ root: { type: 'object', id: 'Factory' }, depth: 3, includeDatasets: true, limit: 50 }) })).json();
    expect(graph.nodes).toHaveLength(4); expect(graph.edges).toHaveLength(3);
    const saved = await api.handle(`${base}/${pkg.id}`, { method: 'PUT', body: JSON.stringify({ ...pkg, name: '我的 SMT 本体' }) });
    expect(saved.status).toBe(200);
    expect((await api.handle(`${base}/${pkg.id}`, { method: 'PUT', body: JSON.stringify(pkg) })).status).toBe(409);
    await new PagesDemoApi(seed(), store).initialize();
    expect((await (await api.handle(`${base}/${pkg.id}`)).json()).name).toBe('我的 SMT 本体');
    expect((await api.handle(`${base}/${pkg.id}/publish`, { method: 'POST', body: '{}' })).status).toBe(409);
    vi.unstubAllGlobals();
  });
  it('executes edited pipelines against real sample rows and diagnoses invalid sources', async () => {
    vi.stubGlobal('window', { location: { origin: 'https://example.test' } });
    const manifest = seed(); manifest.sensorRows = [{ temperature: 20 }, { temperature: 30 }, { temperature: 40 }];
    const api = new PagesDemoApi(manifest, new Store()); await api.initialize();
    const base = '/api/projects/local-project/data-pipelines';
    const [pipeline] = await (await api.handle(base)).json(); pipeline.nodes[1].count = 2;
    expect((await api.handle(base, { method: 'POST', body: JSON.stringify(pipeline) })).status).toBe(200);
    const result = await (await api.handle(`${base}/${pipeline.id}/preview`)).json();
    expect(result.status).toBe('success'); expect(result.rows).toHaveLength(2); expect(result.diagnostics).toHaveLength(3);
    pipeline.nodes[0].datasetId = 'missing';
    await api.handle(base, { method: 'POST', body: JSON.stringify(pipeline) });
    expect((await (await api.handle(`${base}/${pipeline.id}/preview`)).json()).status).toBe('error');
    vi.unstubAllGlobals();
  });
  it('answers from sample data with demo labeling and persists assistant sessions', async () => {
    vi.stubGlobal('window', { location: { origin: 'https://example.test' } });
    const store = new Store(), api = new PagesDemoApi(seed(), store); await api.initialize();
    const result = await (await api.handle('/api/ai/assistant', { method: 'POST', body: JSON.stringify({ question: '平均温度' }) })).json();
    expect(result.text).toContain('【演示助手】'); expect(result.text).toContain('平均 26.00');
    const base = '/api/projects/local-project/ai/assistant-sessions/test';
    await api.handle(base, { method: 'PUT', body: JSON.stringify({ title: '温度查询' }) });
    await api.handle(`${base}/messages/m1`, { method: 'PUT', body: JSON.stringify({ question: '平均温度', answer: result.text, sequence: 1, mode: 'sql', status: 'completed' }) });
    const next = new PagesDemoApi(seed(), store); await next.initialize();
    const loaded = await (await next.handle(`${base}/messages`)).json();
    expect(loaded.messages[0].answer).toBe(result.text); expect(loaded.session.messageCount).toBe(1);
    vi.unstubAllGlobals();
  });
  it('saves semantic metrics and rejects unknown source fields without changing the saved model', async () => {
    vi.stubGlobal('window', { location: { origin: 'https://example.test' } });
    const api = new PagesDemoApi(seed(), new Store()); await api.initialize();
    const base = '/api/projects/local-project/semantic-models';
    const [model] = await (await api.handle(base)).json();
    model.name = '平均温度';
    const updated = await (await api.handle(`${base}/${model.id}`, { method: 'PUT', body: JSON.stringify(model) })).json();
    expect(updated.revision).toBe(2);
    updated.metrics[0].fieldKey = 'missing';
    expect((await api.handle(`${base}/${model.id}`, { method: 'PUT', body: JSON.stringify(updated) })).status).toBe(400);
    expect((await (await api.handle(`${base}/${model.id}`)).json()).metrics[0].fieldKey).toBe('temperature');
    vi.unstubAllGlobals();
  });
  it('lists only real packaged assets with filtered counts and bounded pagination', () => {
    const result = listPagesAssets([item, { ...item, id: 'wood', dimension: 'material', category: '木材' }], new URLSearchParams('dimension=3d&q=SMT&page=99&pageSize=1'));
    expect(result.total).toBe(1); expect(result.page).toBe(1); expect(result.items[0]!.id).toBe('smt');
    expect(result.dimensions.map(x => x.count)).toEqual([1, 1]);
  });
  it('previews the shipped data rows and rejects external data instead of pretending to query it', async () => {
    vi.stubGlobal('window', { location: { origin: 'https://example.test' } });
    const store = new Store(), api = new PagesDemoApi(seed(), store); await api.initialize();
    const response = await api.handle('/api/projects/local-project/datasets/telemetry/preview');
    expect(await response.json()).toMatchObject({ rows: [{ temperature: 26 }] });
    store.state.projects[0]!.datasets![0]!.sourceKey = 'external-db';
    expect((await api.handle('/api/projects/local-project/datasets/telemetry/preview')).status).toBe(409);
    vi.unstubAllGlobals();
  });
  it('rejects modified library bytes before creating a local model', async () => {
    vi.stubGlobal('window', { location: { origin: 'https://example.test' } });
    const store = new Store(), api = new PagesDemoApi(seed(), store, vi.fn(async () => new Response('bad')));
    await api.initialize();
    await expect(api.handle('/api/projects/local-project/asset-library/smt/import', { method: 'POST' })).rejects.toThrow('哈希');
    expect(store.state.projects[0]!.models).toHaveLength(0); expect(store.assets.size).toBe(0);
    vi.unstubAllGlobals();
  });
});
