import { newOntologyPackage, datasetSchemaFingerprint, ontologyPackageFingerprint, queryOntologyGraph,
  parseOntologyGraphQuery, validateOntologyPackageShape, validateOntologyPublishGate,
  type OntologyPackage, type OntologyPackageSnapshot, type OntologyHistoryEntry, type ProjectRecord,
} from '@bim-studio/contracts';
import { jsonResponse, notFound, badRequest, conflict, methodNotAllowed } from './desktopLocalApiHttp';
import type { DesktopLocalWorkspaceState, DesktopLocalWorkspaceStore } from './desktopLocalWorkspaceStore';

export type PagesOntologyState = DesktopLocalWorkspaceState & {
  pagesOntology?: Record<string, Array<{ current: OntologyPackage; snapshots: OntologyPackageSnapshot[]; history: OntologyHistoryEntry[] }>>;
  pagesExperienceVersion?: number;
};

export function createPagesOntology(project: ProjectRecord): OntologyPackage {
  const pkg = newOntologyPackage('SMT 制造', '演示用户');
  Object.assign(pkg, { id: 'pages-smt-ontology', name: 'SMT 产线本体（示例）', revision: 1,
    description: '演示工厂、产线、设备与测点的关系。可以编辑属性、查询图谱、评审和发布；数据保存在当前浏览器。' });
  const dataset = project.datasets?.find(x => x.sourceKey === '/api/demo/sensors');
  pkg.objects = [['Factory', '工厂'], ['Line', '产线'], ['Equipment', '设备'], ['Measurement', '测点']].map(([key, label]) => ({
    id: `smt-${key}`, key: key!, label: label!, domain: pkg.domain, primaryKeys: ['id'], displayKey: 'name',
    properties: [
      { key: 'id', label: '编号', type: 'string', confirmed: true, required: true },
      { key: 'name', label: '名称', type: 'string', confirmed: true },
      { key: 'parentId', label: '上级编号', type: 'string', confirmed: true },
      ...(key === 'Measurement' && dataset ? dataset.fields.filter(f => f.type === 'number').map(f => ({
        key: f.key, label: f.label || f.key, type: 'number' as const, confirmed: true,
      })) : []),
    ],
    sourceBindings: key === 'Measurement' && dataset ? [{ kind: 'dataset', sourceId: dataset.id,
      schemaFingerprint: datasetSchemaFingerprint(dataset), fieldMappings: dataset.fields.filter(f => f.type === 'number').map(f => ({ propertyKey: f.key, fieldKey: f.key })) }]
      : [{ kind: 'manual', sourceId: 'smt-example', note: 'SMT 示例工程的演示结构', fieldMappings: [] }],
    aliases: [], identityMappings: [], status: 'draft', version: 0, owner: pkg.owner,
  }));
  pkg.relations = [['Factory', 'Line', '包含产线'], ['Line', 'Equipment', '包含设备'], ['Equipment', 'Measurement', '产生测点']].map(([source, target, label]) => ({
    id: `smt-${source}-${target}`, key: `${source}_${target}`, label: label!, sourceObject: source!, targetObject: target!,
    cardinality: 'one-to-many', direction: 'directed', properties: [], keyMapping: { sourceField: 'id', targetField: 'parentId' },
    source: { kind: 'manual', sourceId: 'smt-example', note: '演示工厂层级关系' },
    evidence: [{ source: 'SMT 示例结构', sampleCount: 1, recordedAt: pkg.createdAt }], status: 'draft', version: 0,
  }));
  pkg.events = [{ id: 'smt-temperature-event', key: 'temperatureAlarm', label: '温度预警', boundObject: 'Measurement',
    description: '示例事件定义，供查看测点与告警的关系。', status: 'draft', version: 0 }];
  return pkg;
}

export async function seedPagesExperience(store: DesktopLocalWorkspaceStore): Promise<void> {
  const state = await store.read() as PagesOntologyState;
  if (state.pagesExperienceVersion === 1) return;
  state.pagesOntology ??= {};
  for (const project of state.projects) {
    const pkg = createPagesOntology(project);
    state.pagesOntology[project.id] ??= [{ current: pkg, snapshots: [], history: [{ at: pkg.createdAt, by: pkg.owner, action: 'create' }] }];
    const dataset = project.datasets?.find(x => x.sourceKey === '/api/demo/sensors');
    if (dataset && !project.semanticModels?.some(x => x.id === 'pages-smt-metrics')) {
      (project.semanticModels ??= []).push({ id: 'pages-smt-metrics', name: 'SMT 遥测指标（示例）', source: { kind: 'dataset', id: dataset.id },
        metrics: dataset.fields.filter(x => x.type === 'number').map(x => ({ id: `average-${x.key}`, key: `avg_${x.key}`, label: `${x.label || x.key}均值`, fieldKey: x.key, aggregation: 'avg' })),
        dimensions: [], parameters: [], revision: 1, createdAt: pkg.createdAt, updatedAt: pkg.createdAt });
    }
    if (dataset && !project.dataPipelines?.some(x => x.id === 'pages-smt-pipeline')) {
      (project.dataPipelines ??= []).push({ id: 'pages-smt-pipeline', projectId: project.id, name: 'SMT 数据预览（示例）',
        nodes: [{ id: 'source', type: 'source', name: '设备遥测', datasetId: dataset.id, position: { x: 40, y: 100 } },
          { id: 'limit', type: 'limit', name: '最近 10 条', count: 10, position: { x: 300, y: 100 } },
          { id: 'output', type: 'output', name: '输出', position: { x: 560, y: 100 } }],
        edges: [{ id: 'source-limit', sourceNodeId: 'source', targetNodeId: 'limit' }, { id: 'limit-output', sourceNodeId: 'limit', targetNodeId: 'output' }],
        createdAt: pkg.createdAt, updatedAt: pkg.createdAt });
    }
  }
  state.pagesExperienceVersion = 1;
  await store.write(state);
}

export async function pagesOntologyRoute(store: DesktopLocalWorkspaceStore, path: string, method: string, init: RequestInit): Promise<Response | undefined> {
  const match = path.match(/^\/api\/projects\/([^/]+)\/ontology-packages(?:\/([^/]+))?(?:\/([^/]+))?$/);
  if (!match) return;
  const [, encodedProject, encodedId, action] = match, projectId = decodeURIComponent(encodedProject!), id = encodedId && decodeURIComponent(encodedId);
  const state = await store.read() as PagesOntologyState, project = state.projects.find(x => x.id === projectId);
  if (!project) return notFound('项目不存在');
  const items = (state.pagesOntology ??= {})[projectId] ??= [];
  const validate = (pkg: OntologyPackage) => ({ shapeErrors: validateOntologyPackageShape(pkg), gate: validateOntologyPublishGate(pkg, {
    capabilities: [], datasetSchemas: Object.fromEntries((project.datasets ?? []).map(x => [x.id, datasetSchemaFingerprint(x)])),
  }) });
  try {
    const body = init.body ? JSON.parse(String(init.body)) : {};
    if (id === 'validate' && method === 'POST') return jsonResponse(validate(body));
    if (!id && method === 'GET') return jsonResponse(items.map(x => x.current));
    if (!id && method === 'POST') {
      const errors = validateOntologyPackageShape(body); if (errors.length) return badRequest(errors.join('；'));
      if (items.some(x => x.current.id === body.id || x.current.name === body.name)) return conflict('本体 ID 或名称已存在');
      const now = new Date().toISOString(), current = { ...body, status: 'draft', version: 0, revision: 1, createdAt: now, updatedAt: now } as OntologyPackage;
      items.push({ current, snapshots: [], history: [{ at: now, by: current.owner, action: 'create' }] });
      await store.write(state); return jsonResponse(current, 201);
    }
    const entry = items.find(x => x.current.id === id); if (!entry) return notFound('本体不存在');
    const pkg = entry.current;
    if (method === 'GET' && !action) return jsonResponse(pkg);
    if (method === 'GET' && action === 'versions') return jsonResponse({ versions: entry.snapshots.map(({ package: _pkg, ...rest }) => rest), history: entry.history });
    if (method === 'POST' && action === 'graph') {
      const checked = parseOntologyGraphQuery(body); if (!checked.ok) return badRequest(checked.errors.join('；'));
      const start = performance.now(); return jsonResponse({ ...queryOntologyGraph(pkg, checked.query), elapsedMs: performance.now() - start });
    }
    if (method === 'PUT' && !action) {
      if (!['draft', 'review'].includes(pkg.status)) return conflict('请先创建草稿版本');
      if (body.revision !== pkg.revision) return conflict('本体已更新，请重新加载');
      const errors = validateOntologyPackageShape(body); if (errors.length) return badRequest(errors.join('；'));
      entry.current = { ...body, id: pkg.id, status: pkg.status, version: pkg.version, revision: pkg.revision + 1, createdAt: pkg.createdAt, updatedAt: new Date().toISOString() };
    } else if (method === 'DELETE' && !action) {
      if (pkg.status !== 'draft') return conflict('只能删除草稿');
      items.splice(items.indexOf(entry), 1);
    } else if (method === 'POST') {
      const transitions: Record<string, { from: string[]; to: OntologyPackage['status']; history: OntologyHistoryEntry['action'] }> = {
        'submit-review': { from: ['draft'], to: 'review', history: 'review-submit' },
        reject: { from: ['review'], to: 'draft', history: 'review-reject' },
        publish: { from: ['review'], to: 'published', history: 'publish' },
        retire: { from: ['published'], to: 'retired', history: 'retire' },
        'clone-draft': { from: ['published'], to: 'draft', history: 'new-draft-version' },
      };
      if (action === 'rollback') {
        const snapshot = entry.snapshots.find(x => x.snapshotId === body.snapshotId);
        if (!snapshot) return notFound('版本不存在');
        entry.current = { ...structuredClone(snapshot.package), status: 'draft', version: pkg.version, revision: pkg.revision + 1, updatedAt: new Date().toISOString() };
        entry.history.push({ at: entry.current.updatedAt, by: pkg.owner, action: 'rollback', fromVersion: pkg.version, toVersion: snapshot.version });
      } else {
        const transition = transitions[action ?? '']; if (!transition) return methodNotAllowed();
        if (!transition.from.includes(pkg.status)) return conflict('当前状态不支持此操作');
        if (action === 'publish') { const report = validate(pkg); if (report.shapeErrors.length || !report.gate.ok) return badRequest([...report.shapeErrors, ...report.gate.errors].join('；')); }
        pkg.status = transition.to; pkg.revision++; pkg.updatedAt = new Date().toISOString();
        if (action === 'publish') {
          pkg.version++;
          entry.snapshots.push({ snapshotId: crypto.randomUUID(), packageId: pkg.id, version: pkg.version, fingerprint: ontologyPackageFingerprint(pkg), publishedAt: pkg.updatedAt, publishedBy: pkg.owner, package: structuredClone(pkg) });
        }
        entry.history.push({ at: pkg.updatedAt, by: pkg.owner, action: transition.history });
      }
    } else return methodNotAllowed();
    await store.write(state); return jsonResponse(method === 'DELETE' ? { ok: true } : entry.current);
  } catch (error) { return badRequest(error instanceof Error ? error.message : '本体请求无效'); }
}

