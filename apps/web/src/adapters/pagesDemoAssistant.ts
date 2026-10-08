import type { AiSessionSummary, AiSessionMessage, AiSessionMessageInput } from '@bim-studio/contracts';
import type { DesktopLocalWorkspaceState, DesktopLocalWorkspaceStore } from './desktopLocalWorkspaceStore';
import { jsonResponse, badRequest, notFound, conflict, methodNotAllowed } from './desktopLocalApiHttp';
import type { PagesOntologyState } from './pagesDemoOntology';

type AssistantState = DesktopLocalWorkspaceState & { pagesAssistantSessions?: Record<string, { session: AiSessionSummary; messages: AiSessionMessage[] }> };
const model = 'SMT 演示助手（本地数据）';

export async function pagesAssistantRoute(store: DesktopLocalWorkspaceStore, rows: Array<Record<string, unknown>>, url: URL,
  method: string, init: RequestInit): Promise<Response | undefined> {
  if (url.pathname === '/api/ai/assistant/models' && method === 'GET') return jsonResponse({ defaultModel: model, models: [{ id: model, reasoningEfforts: [] }], catalogAvailable: true });
  if (/^\/api\/ai\/assistant(?:\/stream)?$/.test(url.pathname) && method === 'POST') {
    let body: { question?: string; projectId?: string };
    try { body = JSON.parse(String(init.body)); } catch { return badRequest('请求格式无效'); }
    if (!body.question?.trim()) return badRequest('请输入问题');
    const state = await store.read() as PagesOntologyState;
    const project = body.projectId ? state.projects.find(x => x.id === body.projectId) : state.projects[0];
    if (!project) return notFound('项目不存在');
    const question = body.question;
    let answer: string;
    if (/本体|关系|图谱|ontology/i.test(question)) {
      const packages = state.pagesOntology?.[project.id] ?? [];
      answer = packages.map(({ current: pkg }) => `${pkg.name}：${pkg.objects.map(x => x.label).join('、')}。\n${pkg.relations.map(r => `${pkg.objects.find(o => o.key === r.sourceObject)?.label ?? r.sourceObject} → ${r.label} → ${pkg.objects.find(o => o.key === r.targetObject)?.label ?? r.targetObject}`).join('\n')}`).join('\n\n') || '当前项目没有本体包，可在数据中心创建。';
      answer += '\n\n打开“数据中心 → 语义与本体”，可以编辑属性和关系，查看图谱并校验发布条件。';
    } else if (/数据|温度|统计|遥测|平均|最高|最低|sensor|temperature|telemetry|data|average/i.test(question)) {
      const fields = [...new Set(rows.flatMap(row => Object.keys(row)))].filter(key => rows.some(row => typeof row[key] === 'number'));
      answer = `内置遥测共 ${rows.length} 条。\n` + fields.map(key => {
        const values = rows.map(row => row[key]).filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
        return `${key}：最小 ${Math.min(...values).toFixed(2)}，最大 ${Math.max(...values).toFixed(2)}，平均 ${(values.reduce((a, b) => a + b, 0) / values.length).toFixed(2)}。`;
      }).join('\n') + '\n\n可在数据中心修改示例管线的筛选、聚合或条数限制，运行后查看结果。';
    } else if (/场景|模型|资源|设备|scene/i.test(question)) {
      const scenes = state.scenes.filter(x => x.projectId === project.id);
      answer = `项目“${project.name}”包含 ${project.models.length} 个模型资源、${scenes.length} 个场景。\n${project.models.map(x => x.name).join('、')}\n\n进入场景后可选择对象、调整材质和位置，再保存到当前浏览器。`; 
    } else {
      answer = '可以试试：“统计遥测数据”“解释 SMT 本体关系”“有哪些场景和模型”。也可以打开数据中心运行管线，或在本体工作区编辑对象和关系。\n自由问答和自动执行任务需要在完整部署中配置 AI 服务。';
    }
    const result = { model, text: `【演示助手】以下内容由当前浏览器中的示例数据生成。\n\n${answer}` };
    if (!url.pathname.endsWith('/stream')) return jsonResponse(result);
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({ start(controller) {
      if (init.signal?.aborted) { controller.error(init.signal.reason); return; }
      controller.enqueue(encoder.encode(`event: delta\ndata: ${JSON.stringify({ delta: result.text })}\n\nevent: done\ndata: ${JSON.stringify(result)}\n\n`));
      controller.close();
    } });
    return new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
  }
  const match = url.pathname.match(/^\/api\/projects\/([^/]+)\/ai\/assistant-sessions(?:\/([^/]+))?(?:\/messages(?:\/([^/]+))?)?$/);
  if (!match) return;
  const [, rawProject, rawSession, rawMessage] = match, projectId = decodeURIComponent(rawProject!), sessionId = rawSession && decodeURIComponent(rawSession);
  const state = await store.read() as AssistantState;
  if (!state.projects.some(x => x.id === projectId)) return notFound('项目不存在');
  const sessions = state.pagesAssistantSessions ??= {}, key = `${projectId}/${sessionId}`;
  if (method === 'GET' && !sessionId) return jsonResponse({ items: Object.values(sessions).filter(x => x.session.projectId === projectId).map(x => x.session).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)) });
  let record = sessions[key];
  if (method === 'GET') return record ? jsonResponse({ session: record.session, messages: record.messages }) : notFound('会话不存在');
  if (method !== 'PUT' || !sessionId) return methodNotAllowed();
  let body;
  try { body = JSON.parse(String(init.body)); } catch { return badRequest('请求格式无效'); }
  const now = new Date(Math.max(Date.now(), Date.parse(record?.session.updatedAt ?? '') + 1 || 0)).toISOString();
  if (!rawMessage) {
    if (typeof body.title !== 'string') return badRequest('缺少会话标题');
    record ??= sessions[key] = { session: { id: sessionId, projectId, title: body.title, createdAt: now, updatedAt: now, messageCount: 0 }, messages: [] };
    record.session.title = body.title; record.session.updatedAt = now;
    await store.write(state); return jsonResponse(record.session);
  }
  if (!record) return notFound('会话不存在');
  const messageId = decodeURIComponent(rawMessage), existing = record.messages.find(x => x.id === messageId);
  const ifMatch = new Headers(init.headers).get('if-match');
  if (ifMatch && existing?.updatedAt !== ifMatch) return conflict('消息已更新，请重新加载');
  if (!Number.isSafeInteger(body.sequence) || typeof body.question !== 'string' || typeof body.answer !== 'string') return badRequest('消息格式无效');
  if (existing && body.sequence < existing.sequence) return conflict('消息版本已过期');
  const message: AiSessionMessage = { ...(body as AiSessionMessageInput), id: messageId, createdAt: existing?.createdAt ?? now, updatedAt: now };
  if (existing) record.messages[record.messages.indexOf(existing)] = message; else record.messages.push(message);
  record.session.updatedAt = now; record.session.messageCount = record.messages.length;
  await store.write(state); return jsonResponse(message);
}
