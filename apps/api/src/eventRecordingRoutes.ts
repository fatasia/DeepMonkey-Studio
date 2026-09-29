/**
 * C4 事件级持久录制路由(2026-09-29)。
 *
 * 挂载纪律:本模块由既有事件路由模块 dataEvents.ts 的 registerDataEventRoutes
 * 可选挂载(recording 依赖注入即启用);不改 routes.ts,生产接线(index.ts 传
 * dataDir)与 UI 接线同属后续切片,未接线前注册行为与现状完全一致。
 *
 * 路由面(全部以既有 /api/projects/:projectId/data 前缀对齐 data/events):
 * - POST /recordings                 开新录制(仿真/注入必须如实声明 sourceOrigin)
 * - POST /recordings/:id/record      注入单条事件(逐事件落盘)
 * - POST /recordings/:id/close       闭合当前段
 * - POST /recordings/:id/resume      checkpoint 恢复接缝(close 之后继续录制)
 * - GET  /recordings                 录制清单(manifest + 完整性评估)
 * - GET  /recordings/:id             录制文件 + 完整性评估(mismatches 原样透出)
 *
 * 完整性纪律:读端一律返回 assess 结果(重算口径),声明与条目不符时
 * integrityOk=false 且 mismatches 原样下发——路由层不做任何"修复"。
 */
import type { FastifyInstance } from "fastify";
import {
  assessEventRecording,
  type EventRecordingFile,
  type EventRecordingFrameMapping,
  type EventRecordingResumeOrigin,
} from "@bim-studio/contracts";
import type { MetadataStore } from "./store.js";
import { EventRecordingFileStore, EventRecordingSession, type EventRecordingInput } from "./eventRecording.js";

export interface EventRecordingRouteDependencies {
  store: MetadataStore;
  /** 录制文件根目录(生产为 config.dataDir);宿主显式注入,不隐式取环境。 */
  dir: string;
  now?: () => number;
}

interface OpenRecordingBody {
  recordingId?: string;
  connectionId?: string;
  protocol?: string;
  sourceOrigin?: string;
  frameMapping?: EventRecordingFrameMapping | null;
}

type RecordBody = Partial<EventRecordingInput> & { sequence?: number };

interface ResumeBody {
  connectionId?: string;
  generation?: number;
  lastSequence?: number | null;
  lastTimestamp?: string | null;
  reason?: string;
}

export async function registerEventRecordingRoutes(app: FastifyInstance, dependencies: EventRecordingRouteDependencies): Promise<EventRecordingFileStore> {
  const store = new EventRecordingFileStore(dependencies.dir);
  const requireProject = (projectId: string) => Boolean(dependencies.store.getProject(projectId));

  app.post<{ Params: { projectId: string }; Body: OpenRecordingBody }>("/api/projects/:projectId/data/recordings", async (request, reply) => {
    if (!requireProject(request.params.projectId)) return reply.code(404).send({ message: "项目不存在" });
    const body = request.body ?? {};
    const sourceOrigin = body.sourceOrigin;
    if (sourceOrigin !== "simulation" && sourceOrigin !== "injected" && sourceOrigin !== "subscription") {
      return reply.code(400).send({ message: "sourceOrigin 必须如实声明为 simulation/injected/subscription;录制不冒充真实采集来源" });
    }
    const recordingId = body.recordingId?.trim() || `rec-${new Date(dependencies.now?.() ?? Date.now()).toISOString().replace(/[^0-9TZ]/g, "")}-${Math.random().toString(36).slice(2, 8)}`;
    const session = new EventRecordingSession({
      recordingId,
      projectId: request.params.projectId,
      ...(body.connectionId ? { connectionId: body.connectionId } : {}),
      ...(body.protocol ? { protocol: body.protocol } : {}),
      sourceOrigin,
      ...(body.frameMapping !== undefined ? { frameMapping: body.frameMapping } : {}),
      ...(dependencies.now ? { now: dependencies.now } : {}),
    });
    try {
      await store.begin(session);
    } catch (error) {
      return reply.code(409).send({ message: error instanceof Error ? error.message : String(error) });
    }
    return reply.code(201).send(withAssessment(await store.load(request.params.projectId, recordingId) ?? session.file()));
  });

  app.post<{ Params: { projectId: string; recordingId: string }; Body: RecordBody }>("/api/projects/:projectId/data/recordings/:recordingId/record", async (request, reply) => {
    if (!requireProject(request.params.projectId)) return reply.code(404).send({ message: "项目不存在" });
    const file = await store.load(request.params.projectId, request.params.recordingId);
    if (!file) return reply.code(404).send({ message: `录制 ${request.params.recordingId} 不存在` });
    const session = sessionFromFile(file, dependencies.now);
    const body = request.body ?? {};
    if (typeof body.source !== "string" || typeof body.key !== "string" || !("value" in body)) {
      return reply.code(400).send({ message: "录制事件必须包含 source、key 和 value" });
    }
    let receipt;
    try {
      receipt = session.record({
        source: body.source,
        key: body.key,
        value: body.value,
        ...(typeof body.timestamp === "string" ? { timestamp: body.timestamp } : { timestamp: new Date(dependencies.now?.() ?? Date.now()).toISOString() }),
        ...(body.sequence !== undefined ? { sequence: body.sequence } : {}),
        ...(typeof body.sceneId === "string" ? { sceneId: body.sceneId } : {}),
      });
    } catch (error) {
      return reply.code(409).send({ message: error instanceof Error ? error.message : String(error) });
    }
    await store.persist(session);
    return reply.code(202).send({ receipt: { kind: receipt.kind }, recording: withAssessment(session.file()) });
  });

  app.post<{ Params: { projectId: string; recordingId: string } }>("/api/projects/:projectId/data/recordings/:recordingId/close", async (request, reply) => {
    if (!requireProject(request.params.projectId)) return reply.code(404).send({ message: "项目不存在" });
    const file = await store.load(request.params.projectId, request.params.recordingId);
    if (!file) return reply.code(404).send({ message: `录制 ${request.params.recordingId} 不存在` });
    const session = sessionFromFile(file, dependencies.now);
    session.close();
    await store.persist(session);
    return withAssessment(session.file());
  });

  app.post<{ Params: { projectId: string; recordingId: string }; Body: ResumeBody }>("/api/projects/:projectId/data/recordings/:recordingId/resume", async (request, reply) => {
    if (!requireProject(request.params.projectId)) return reply.code(404).send({ message: "项目不存在" });
    const file = await store.load(request.params.projectId, request.params.recordingId);
    if (!file) return reply.code(404).send({ message: `录制 ${request.params.recordingId} 不存在` });
    const body = request.body ?? {};
    if (typeof body.connectionId !== "string" || !body.connectionId) {
      return reply.code(400).send({ message: "接缝恢复必须声明 connectionId(T24 SubscriptionCheckpoint 口径)" });
    }
    // generation 必须由调用方如实声明;缺失或非法直接拒绝,不用 0 伪造出处。
    if (typeof body.generation !== "number" || !Number.isSafeInteger(body.generation) || body.generation < 0) {
      return reply.code(400).send({ message: "接缝恢复必须携带合法 generation(checkpoint 治理序号),不得缺省补 0" });
    }
    const origin: EventRecordingResumeOrigin = {
      connectionId: body.connectionId,
      generation: body.generation,
      lastSequence: typeof body.lastSequence === "number" && Number.isSafeInteger(body.lastSequence) && body.lastSequence >= 0 ? body.lastSequence : null,
      lastTimestamp: typeof body.lastTimestamp === "string" && Number.isFinite(Date.parse(body.lastTimestamp)) ? body.lastTimestamp : null,
    };
    const session = sessionFromFile(file, dependencies.now);
    try {
      session.resume(origin, body.reason === "manual-reopen" ? "manual-reopen" : "checkpoint-resume");
    } catch (error) {
      return reply.code(409).send({ message: error instanceof Error ? error.message : String(error) });
    }
    await store.persist(session);
    return reply.code(201).send(withAssessment(session.file()));
  });

  app.get<{ Params: { projectId: string } }>("/api/projects/:projectId/data/recordings", async (request, reply) => {
    if (!requireProject(request.params.projectId)) return reply.code(404).send({ message: "项目不存在" });
    const manifests = await store.list(request.params.projectId);
    const items = [];
    for (const manifest of manifests) {
      const file = await store.load(request.params.projectId, manifest.recordingId);
      items.push({ manifest, assessment: file ? assessEventRecording(file) : null });
    }
    return { items };
  });

  app.get<{ Params: { projectId: string; recordingId: string } }>("/api/projects/:projectId/data/recordings/:recordingId", async (request, reply) => {
    if (!requireProject(request.params.projectId)) return reply.code(404).send({ message: "项目不存在" });
    const file = await store.load(request.params.projectId, request.params.recordingId);
    if (!file) return reply.code(404).send({ message: `录制 ${request.params.recordingId} 不存在` });
    return withAssessment(file);
  });

  return store;
}

/** 从已落盘文件重建会话(历史条目保真、水位恢复),继续追加。 */
function sessionFromFile(file: EventRecordingFile, now: (() => number) | undefined): EventRecordingSession {
  return EventRecordingSession.fromFile(file, now);
}

function withAssessment(file: EventRecordingFile): { recording: EventRecordingFile; assessment: ReturnType<typeof assessEventRecording> } {
  return { recording: file, assessment: assessEventRecording(file) };
}
