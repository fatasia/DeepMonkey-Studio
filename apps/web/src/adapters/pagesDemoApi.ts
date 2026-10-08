import type { AssetLibraryItem, AssetLibraryPage, DataDatasetRecord, DataPipelineDefinition, ProjectAssetMapRecord, ProjectAssetRecord, SemanticModelRecord } from '@bim-studio/contracts';
import { pagesOntologyRoute, seedPagesExperience } from './pagesDemoOntology';
import { pagesAssistantRoute } from './pagesDemoAssistant';
import { DesktopLocalApi } from './desktopLocalApi';
import { IndexedDbDesktopLocalWorkspaceStore, type DesktopLocalWorkspaceState, type DesktopLocalWorkspaceStore } from './desktopLocalWorkspaceStore';
import { jsonResponse, notFound, serverOnly, badRequest, conflict } from './desktopLocalApiHttp';
import { isPagesDemoRuntime, pagesDemoManifestUrl } from './pagesDemoRuntime';
import { DEFAULT_BRANDING } from '../appDefaults';
import { applicationPath } from './browserRuntimeConfig';

export interface PagesDemoManifest {
  schemaVersion: 1;
  state: DesktopLocalWorkspaceState;
  library: Array<{ item: AssetLibraryItem; maps: ProjectAssetMapRecord[] }>;
  sensorRows: Array<Record<string, unknown>>;
  defaultPath: string;
}
type PagesState = DesktopLocalWorkspaceState & { pagesSeedVersion?: number };

/** Browser workspace persists edits through the existing local API, never through a public write endpoint. */
export class PagesDemoApi {
  private readonly local: DesktopLocalApi;
  private queue: Promise<void> = Promise.resolve();
  constructor(private readonly manifest: PagesDemoManifest, private readonly store: DesktopLocalWorkspaceStore,
    private readonly transport: typeof fetch = globalThis.fetch.bind(globalThis)) {
    this.local = new DesktopLocalApi(store, transport);
  }
  async initialize(): Promise<void> {
    const current = await this.store.read() as PagesState;
    if (current.pagesSeedVersion === undefined) await this.store.write({ ...structuredClone(this.manifest.state), pagesSeedVersion: 1 } as PagesState);
    await seedPagesExperience(this.store);
  }
  get defaultPath(): string { return this.manifest.defaultPath; }
  async handle(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url, window.location.origin);
    if (!url.pathname.startsWith('/api/')) return this.transport(input, init);
    const method = (init.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    if (method === 'GET') return this.route(url, method, init);
    const prior = this.queue;
    let release!: () => void;
    this.queue = new Promise(resolve => { release = resolve; });
    await prior;
    try { return await this.route(url, method, init); } finally { release(); }
  }
  private async route(url: URL, method: string, init: RequestInit): Promise<Response> {
    const path = url.pathname;
    if (path === '/api/meta' && method === 'GET') {
      const meta = await (await this.local.handle(url, init)).json();
      return jsonResponse({ ...meta, serverInstanceId: 'pages-local', capabilities: { ...meta.capabilities,
        hosts: { browser: true, tauri: false } } });
    }
    if (path === '/api/public/branding') return jsonResponse({ ...DEFAULT_BRANDING,
      logoUrl: applicationPath(DEFAULT_BRANDING.logoUrl), iconUrl: applicationPath(DEFAULT_BRANDING.iconUrl) });
    if (path === '/api/asset-library' && method === 'GET') return jsonResponse(listPagesAssets(this.manifest.library.map(x => x.item), url.searchParams));
    const itemRoute = path.match(/^\/api\/asset-library\/items\/([^/]+)(?:\/maps)?$/);
    if (itemRoute && method === 'GET') {
      const entry = this.manifest.library.find(x => x.item.id === decodeURIComponent(itemRoute[1]!));
      return entry ? jsonResponse(path.endsWith('/maps') ? entry.maps : entry.item) : notFound('素材不存在');
    }
    const imported = path.match(/^\/api\/projects\/([^/]+)\/asset-library\/([^/]+)\/import$/);
    if (imported && method === 'POST') return this.importItem(decodeURIComponent(imported[1]!), decodeURIComponent(imported[2]!));
    if (path === '/api/demo/sensors') return jsonResponse(this.manifest.sensorRows);
    const ontology = await pagesOntologyRoute(this.store, path, method, init); if (ontology) return ontology;
    const assistant = await pagesAssistantRoute(this.store, this.manifest.sensorRows, url, method, init); if (assistant) return assistant;
    const resources = path.match(/^\/api\/projects\/([^/]+)\/(assets|data-connections|datasets|data-pipelines|data-endpoints|semantic-models)(?:\/([^/]+))?(?:\/(preview|diagnostics|test))?$/);
    if (resources) return this.projectResources(decodeURIComponent(resources[1]!), resources[2]!, resources[3], resources[4], method, init, url);
    return this.local.handle(url, { ...init, method });
  }
  private async importItem(projectId: string, itemId: string): Promise<Response> {
    const entry = this.manifest.library.find(x => x.item.id === itemId);
    const state = await this.store.read(), project = state.projects.find(x => x.id === projectId);
    if (!entry || !project) return notFound('素材或项目不存在');
    const { item, maps } = entry;
    const existing = project.models.find(x => x.libraryOrigin?.contentHash === item.contentHash)
      ?? project.assets?.find(x => x.libraryOrigin?.contentHash === item.contentHash);
    if (existing) return jsonResponse({ kind: 'manifest' in existing ? 'model' : 'resource', ['manifest' in existing ? 'model' : 'asset']: existing, reused: true });
    const origin = { itemId, contentHash: item.contentHash, catalogVersion: 1 as const, version: item.version,
      license: item.license, publicationStatus: item.publicationStatus, ...(item.attribution ? { attribution: item.attribution } : {}) };
    const now = new Date().toISOString();
    if (item.dimension === '3d') {
      const response = await this.transport(item.previewUrl);
      if (!response.ok) throw new Error(`素材下载失败（HTTP ${response.status}）`);
      const bytes = await response.arrayBuffer();
      const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), x => x.toString(16).padStart(2, '0')).join('');
      if (digest !== item.contentHash.toLowerCase()) throw new Error('素材字节与目录哈希不一致');
      const body = new FormData(); body.append('file', new File([bytes], `${item.name}.glb`, { type: 'model/gltf-binary' }));
      const result = await this.local.handle(`/api/projects/${projectId}/models`, { method: 'POST', body });
      if (!result.ok) return result;
      const model = await result.json(); model.libraryOrigin = origin; model.thumbnailUrl = item.thumbnailUrl;
      const latest = await this.store.read(), target = latest.projects.find(x => x.id === projectId)!;
      const index = target.models.findIndex(x => x.id === model.id); target.models[index] = model;
      await this.store.write(latest); return jsonResponse({ kind: 'model', model, reused: false }, 201);
    }
    const asset: ProjectAssetRecord = { id: crypto.randomUUID(), projectId, name: item.name, fileName: item.name,
      kind: item.dimension === 'material' ? 'pbr-material' : 'environment', mimeType: item.format === 'exr' ? 'image/x-exr' : 'application/octet-stream',
      size: item.size, url: maps[0]?.url ?? item.previewUrl, thumbnailUrl: item.thumbnailUrl, maps, libraryOrigin: origin, createdAt: now, updatedAt: now };
    (project.assets ??= []).push(asset); project.updatedAt = now; await this.store.write(state);
    return jsonResponse({ kind: 'resource', asset, reused: false }, 201);
  }
  private async projectResources(projectId: string, kind: string, id: string | undefined, action: string | undefined, method: string, init: RequestInit, url: URL): Promise<Response> {
    const state = await this.store.read(), project = state.projects.find(x => x.id === projectId);
    if (!project) return notFound('项目不存在');
    if (kind === 'data-connections' && id === 'diagnostics') return jsonResponse([]);
    const keys = { assets: 'assets', 'data-connections': 'dataConnections', datasets: 'datasets', 'data-pipelines': 'dataPipelines',
      'data-endpoints': 'dataEndpoints', 'semantic-models': 'semanticModels' } as const;
    const key = keys[kind as keyof typeof keys];
    const collection = (project[key] ?? []) as unknown as Array<{ id: string; [key: string]: unknown }>;
    if (method === 'POST' && kind === 'data-connections' && action === 'test') {
      const record = collection.find(x => x.id === id);
      if (!record) return notFound('数据连接不存在');
      if ((record.config as { url?: string })?.url !== '/api/demo/sensors') return serverOnly('外部数据连接');
      return jsonResponse({ ok: true, status: 'healthy', durationMs: 0, rowCount: this.manifest.sensorRows.length,
        fieldCount: Object.keys(this.manifest.sensorRows[0] ?? {}).length, checkedAt: new Date().toISOString() });
    }
    if (method === 'GET') {
      if (!id) return jsonResponse(collection);
      const record = collection.find(x => x.id === decodeURIComponent(id));
      if (!record) return notFound('资源不存在');
      if (kind === 'datasets' && action === 'preview') {
        const dataset = record as unknown as DataDatasetRecord;
        if (dataset.sourceKey !== '/api/demo/sensors') return serverOnly('外部数据源');
        return jsonResponse({ dataset, fields: dataset.fields, rows: this.manifest.sensorRows, durationMs: 0 });
      }
      if (kind === 'data-pipelines' && action === 'preview') {
        const { executeDataPipeline, DataPipelineError } = await import('@bim-studio/data-runtime/pipeline');
        const pipeline = record as unknown as DataPipelineDefinition;
        try { return jsonResponse(await executeDataPipeline(pipeline, async datasetId => {
          const dataset = project.datasets?.find(x => x.id === datasetId);
          if (!dataset || dataset.sourceKey !== '/api/demo/sensors') throw new Error('此演示仅能读取当前项目内置的遥测数据集');
          return structuredClone(this.manifest.sensorRows);
        }, url.searchParams.has('throughNodeId') ? { throughNodeId: url.searchParams.get('throughNodeId')! } : {})); }
        catch (error) { return jsonResponse({ pipeline, status: 'error', fields: [], rows: [], durationMs: 0,
          diagnostics: error instanceof DataPipelineError ? error.diagnostics : [], failedNodeId: error instanceof DataPipelineError ? error.nodeId : undefined,
          error: error instanceof Error ? error.message : '管线运行失败' }); }
      }
      return jsonResponse(record);
    }
    if (kind === 'semantic-models' && (method === 'POST' || method === 'PUT')) {
      try {
        const body = JSON.parse(String(init.body));
        const existing = collection.find(x => x.id === (id ?? body.id));
        if (method === 'PUT' && !existing) return notFound('语义模型不存在');
        if (existing && body.revision !== existing.revision) return conflict('语义模型已更新，请重新加载');
        if (collection.some(x => x !== existing && x.name === body.name)) return conflict('语义模型名称已存在');
        const { validateSemanticModel } = await import('@bim-studio/data-runtime/semantic');
        const now = new Date().toISOString();
        const model: SemanticModelRecord = { ...body, id: existing?.id ?? crypto.randomUUID(), revision: Number(existing?.revision ?? 0) + 1,
          metrics: body.metrics ?? [], dimensions: body.dimensions ?? [], parameters: body.parameters ?? [], createdAt: existing?.createdAt ?? now, updatedAt: now };
        const errors = validateSemanticModel(model, { listDatasets: () => project.datasets ?? [], listDataPipelines: () => project.dataPipelines ?? [] }, projectId);
        if (errors.length) return badRequest(errors.join('；'));
        const saved = model as unknown as { id: string; [key: string]: unknown };
        if (existing) collection[collection.indexOf(existing)] = saved; else collection.push(saved);
        Object.assign(project, { [key]: collection }); await this.store.write(state); return jsonResponse(model, existing ? 200 : 201);
      } catch (error) { return badRequest(error instanceof Error ? error.message : '语义模型格式无效'); }
    }
    if (!['assets', 'data-connections', 'datasets', 'data-pipelines', 'semantic-models'].includes(kind)) return serverOnly(`${kind}写入`);
    if (method === 'DELETE' && id) {
      const index = collection.findIndex(x => x.id === decodeURIComponent(id)); if (index < 0) return notFound('资源不存在');
      collection.splice(index, 1);
    } else if (method === 'PATCH' && kind === 'assets' && id) {
      const record = collection.find(x => x.id === decodeURIComponent(id)); if (!record) return notFound('资源不存在');
      const body = JSON.parse(String(init.body)); if (typeof body.name === 'string') record.name = body.name;
      record.updatedAt = new Date().toISOString();
      await this.store.write(state); return jsonResponse(record);
    } else if (method === 'POST' && !id && kind !== 'assets') {
      const body = JSON.parse(String(init.body));
      if (kind === 'data-pipelines') {
        const { validateDataPipeline } = await import('@bim-studio/data-runtime/pipeline');
        try { validateDataPipeline(body); } catch (error) { return badRequest(error instanceof Error ? error.message : '管线无效'); }
        const now = new Date().toISOString(), existing = collection.find(x => x.id === body.id);
        const saved = { ...body, id: existing?.id ?? crypto.randomUUID(), projectId, createdAt: existing?.createdAt ?? now, updatedAt: now };
        if (existing) collection[collection.indexOf(existing)] = saved; else collection.push(saved);
        Object.assign(project, { [key]: collection }); await this.store.write(state); return jsonResponse(saved, existing ? 200 : 201);
      }
      if (kind === 'data-connections' && body.config?.url !== '/api/demo/sensors') return serverOnly('外部数据连接');
      if (kind === 'datasets' && body.sourceKey !== '/api/demo/sensors') return serverOnly('外部数据集');
      const now = new Date().toISOString(); collection.push({ ...body, id: crypto.randomUUID(), projectId, createdAt: now, updatedAt: now });
    } else return serverOnly(`${kind}请求`);
    Object.assign(project, { [key]: collection }); await this.store.write(state);
    return jsonResponse(method === 'DELETE' ? { ok: true } : collection.at(-1), method === 'DELETE' ? 200 : 201);
  }
}

export function listPagesAssets(items: AssetLibraryItem[], query: URLSearchParams): AssetLibraryPage {
  const count = (values: AssetLibraryItem[], key: 'category' | 'dimension') => Array.from(values.reduce((map, item) => map.set(item[key], (map.get(item[key]) ?? 0) + 1), new Map<string, number>()), ([id, count]) => ({ id, name: id, count }));
  const dimension = query.get('dimension'), category = query.get('category'), search = query.get('q')?.toLocaleLowerCase() ?? '';
  const dimensions = items.filter(x => !dimension || dimension === 'all' || x.dimension === dimension);
  const filtered = dimensions.filter(x => (!category || category === 'all' || x.category === category)
    && (query.get('featured') !== 'true' || x.featured) && `${x.name} ${x.category} ${x.tags.join(' ')}`.toLocaleLowerCase().includes(search));
  const pageSize = Math.max(1, Math.min(100, Number(query.get('pageSize')) || 24)), totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const page = Math.max(1, Math.min(totalPages, Number(query.get('page')) || 1));
  return { items: filtered.slice((page - 1) * pageSize, page * pageSize), page, pageSize, total: filtered.length, totalPages,
    categories: count(dimensions, 'category'), dimensions: count(items, 'dimension') };
}

let runtime: Promise<PagesDemoApi> | undefined;
export async function initializePagesDemo(): Promise<PagesDemoApi | undefined> {
  if (!isPagesDemoRuntime()) return;
  return runtime ??= (async () => {
    const response = await fetch(pagesDemoManifestUrl(), { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`示例工程清单加载失败（HTTP ${response.status}）`);
    const manifest = await response.json() as PagesDemoManifest;
    if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.library) || !Array.isArray(manifest.state?.projects)) throw new Error('示例清单格式无效');
    const api = new PagesDemoApi(manifest, new IndexedDbDesktopLocalWorkspaceStore('deepmonkey-pages-workspace'));
    await api.initialize(); return api;
  })();
}
export async function pagesDemoFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const api = await initializePagesDemo(); if (!api) throw new Error('浏览器示例尚未启用');
  return api.handle(input, init);
}
