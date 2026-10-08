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
    ['/api/ai/assistant', 'POST'],
    ['/api/cloud-render/capability', 'GET'],
    ['/api/projects/local-project/scenes/smt/native-candidates', 'POST'],
    ['/api/projects/local-project/scenes/smt/publications/1/dependencies', 'GET'],
    ['/api/projects/local-project/scenes/smt/publications/1/native-executable', 'POST'],
    ['/api/projects/local-project/data-pipelines', 'POST'],
    ['/api/projects/local-project/data-endpoints', 'POST'],
  ])('reports the server requirement for %s without calling a remote API', async (path, method) => {
    vi.stubGlobal('window', { location: { origin: 'https://example.test' } });
    const transport = vi.fn(), api = new PagesDemoApi(seed(), new Store(), transport);
    await api.initialize();
    const response = await api.handle(path, { method, body: method === 'POST' ? '{}' : undefined });
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
