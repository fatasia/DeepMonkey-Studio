import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { EventRecordingFile } from "@bim-studio/contracts";
import { createApiServer } from "./serverOptions.js";
import { JsonStore } from "./store.js";
import { registerDataEventRoutes } from "./dataEvents.js";

const directories: string[] = [];

afterEach(async () => Promise.all(directories.splice(0).map((item) => rm(item, { recursive: true, force: true }))));

interface Harness {
  projectId: string;
  inject: (method: string, url: string, payload?: unknown) => Promise<{ statusCode: number; json: () => never }>;
}

/** 走既有事件路由模块挂载:recording 依赖注入即启用 /data/recordings 子路由。 */
async function createHarness(withRecording: boolean): Promise<Harness> {
  const dataDir = await mkdtemp(path.join(tmpdir(), "bim-event-recording-routes-"));
  directories.push(dataDir);
  const store = new JsonStore(dataDir);
  await store.init();
  const project = await store.createProject("事件录制路由测试项目");
  const app = createApiServer();
  await registerDataEventRoutes(app, store, undefined, withRecording ? { recording: { dir: dataDir } } : undefined);
  await app.ready();
  return {
    projectId: project.id,
    inject: async (method, url, payload) => {
      const response = await app.inject({ method, url, ...(payload !== undefined ? { payload } : {}) });
      return { statusCode: response.statusCode, json: response.json.bind(response) as () => never };
    },
  };
}

const OPEN_BODY = { sourceOrigin: "simulation", connectionId: "conn-sim-1", protocol: "simulation", frameMapping: { frameStepMs: 100, mode: "floor" } };

describe("C4 事件录制路由(既有事件路由模块挂载)", () => {
  it("未注入 recording 依赖:挂载面与现状一致,录制端点不存在(生产接线留后续切片)", async () => {
    const harness = await createHarness(false);
    const response = await harness.inject("POST", `/api/projects/${harness.projectId}/data/recordings`, OPEN_BODY);
    expect(response.statusCode).toBe(404);
    // 既有事件端点不受影响。
    const events = await harness.inject("GET", `/api/projects/${harness.projectId}/data/events/latest`);
    expect(events.statusCode).toBe(200);
  });

  it("开录制→注入→闭合→读回:assessment 重算 integrityOk=true,清单可见 manifest", async () => {
    const harness = await createHarness(true);
    const opened = await harness.inject("POST", `/api/projects/${harness.projectId}/data/recordings`, OPEN_BODY);
    expect(opened.statusCode).toBe(201);
    const recordingId = (opened.json() as { recording: EventRecordingFile }).recording.manifest.recordingId;

    const missingOrigin = await harness.inject("POST", `/api/projects/${harness.projectId}/data/recordings`, { ...OPEN_BODY, sourceOrigin: undefined });
    expect(missingOrigin.statusCode).toBe(400);

    for (const sequence of [1, 2]) {
      const recorded = await harness.inject("POST", `/api/projects/${harness.projectId}/data/recordings/${recordingId}/record`, {
        source: "sim/plc", key: "temperature", value: 21.5, timestamp: `2026-09-29T00:00:0${sequence}.000Z`, sequence,
      });
      expect(recorded.statusCode).toBe(202);
      expect((recorded.json() as { receipt: { kind: string } }).receipt.kind).toBe("event");
    }
    const closed = await harness.inject("POST", `/api/projects/${harness.projectId}/data/recordings/${recordingId}/close`);
    expect(closed.statusCode).toBe(200);
    const closedBody = closed.json() as { recording: EventRecordingFile; assessment: { completeness: string; integrityOk: boolean; mismatches: string[] } };
    expect(closedBody.assessment).toMatchObject({ completeness: "continuous", integrityOk: true, mismatches: [] });
    expect(closedBody.recording.manifest.closedAt).not.toBeNull();

    const detail = await harness.inject("GET", `/api/projects/${harness.projectId}/data/recordings/${recordingId}`);
    expect(detail.statusCode).toBe(200);
    expect((detail.json() as { assessment: { completeness: string } }).assessment.completeness).toBe("continuous");

    const list = await harness.inject("GET", `/api/projects/${harness.projectId}/data/recordings`);
    expect((list.json() as { items: Array<{ manifest: { recordingId: string } }> }).items.map((item) => item.manifest.recordingId)).toEqual([recordingId]);
  });

  it("注入乱序与断段:completeness 如实 gapped,条目显式呈现,绝不补造完整假象", async () => {
    const harness = await createHarness(true);
    const opened = await harness.inject("POST", `/api/projects/${harness.projectId}/data/recordings`, OPEN_BODY);
    const recordingId = (opened.json() as { recording: EventRecordingFile }).recording.manifest.recordingId;

    const injectSequence = async (sequence: number, value: number) => harness.inject("POST", `/api/projects/${harness.projectId}/data/recordings/${recordingId}/record`, {
      source: "sim/plc", key: "pressure", value, timestamp: `2026-09-29T00:00:${String(sequence).padStart(2, "0")}.000Z`, sequence,
    });
    await injectSequence(1, 1);
    await injectSequence(2, 2);
    // 乱序:回执 out-of-order;条目 disposition=rejected 原样可读。
    const late = await injectSequence(1, 1.5);
    expect((late.json() as { receipt: { kind: string } }).receipt.kind).toBe("out-of-order");
    // 断段:回执 gap,缺失区间显式落条目。
    const jumped = await injectSequence(5, 5);
    expect((jumped.json() as { receipt: { kind: string } }).receipt.kind).toBe("gap");
    await harness.inject("POST", `/api/projects/${harness.projectId}/data/recordings/${recordingId}/close`);

    const detail = await harness.inject("GET", `/api/projects/${harness.projectId}/data/recordings/${recordingId}`);
    const body = detail.json() as { recording: EventRecordingFile; assessment: { completeness: string; integrityOk: boolean } };
    expect(body.assessment).toMatchObject({ completeness: "gapped", integrityOk: true });
    const entries = body.recording.segments.flatMap((segment) => segment.entries);
    expect(entries.find((entry) => entry.kind === "out-of-order")).toMatchObject({ sequence: 1, observedSequence: 2, disposition: "rejected" });
    expect(entries.find((entry) => entry.kind === "gap")).toMatchObject({ fromSequence: 3, toSequence: 4, estimatedCount: 2, sequenceKnown: true });
    // 完整性即事实:事件只有 3 条(1/2/5),没有任何伪造的 3/4 号。
    expect(body.recording.manifest.totals.eventCount).toBe(3);
  });

  it("checkpoint 恢复接缝路由:闭合后 resume 落 seam,接缝后缺口按恢复水位对账", async () => {
    const harness = await createHarness(true);
    const opened = await harness.inject("POST", `/api/projects/${harness.projectId}/data/recordings`, OPEN_BODY);
    const recordingId = (opened.json() as { recording: EventRecordingFile }).recording.manifest.recordingId;
    const recordUrl = `/api/projects/${harness.projectId}/data/recordings/${recordingId}/record`;
    await harness.inject("POST", recordUrl, { source: "sim/plc", key: "k", value: 1, timestamp: "2026-09-29T00:00:01.000Z", sequence: 1 });
    await harness.inject("POST", recordUrl, { source: "sim/plc", key: "k", value: 2, timestamp: "2026-09-29T00:00:02.000Z", sequence: 2 });
    await harness.inject("POST", `/api/projects/${harness.projectId}/data/recordings/${recordingId}/close`);

    const resumed = await harness.inject("POST", `/api/projects/${harness.projectId}/data/recordings/${recordingId}/resume`, {
      connectionId: "conn-sim-1", generation: 7, lastSequence: 2, lastTimestamp: "2026-09-29T00:00:02.000Z", reason: "checkpoint-resume",
    });
    expect(resumed.statusCode).toBe(201);
    const jumped = await harness.inject("POST", recordUrl, { source: "sim/plc", key: "k", value: 5, timestamp: "2026-09-29T00:00:09.000Z", sequence: 5 });
    expect((jumped.json() as { receipt: { kind: string } }).receipt.kind).toBe("gap");
    await harness.inject("POST", `/api/projects/${harness.projectId}/data/recordings/${recordingId}/close`);

    const detail = await harness.inject("GET", `/api/projects/${harness.projectId}/data/recordings/${recordingId}`);
    const body = detail.json() as { recording: EventRecordingFile; assessment: { completeness: string; integrityOk: boolean } };
    expect(body.recording.segments).toHaveLength(2);
    expect(body.recording.segments[1]?.resume).toMatchObject({ connectionId: "conn-sim-1", generation: 7, lastSequence: 2 });
    expect(body.recording.segments[1]?.entries[0]).toMatchObject({ kind: "seam", reason: "checkpoint-resume" });
    expect(body.recording.segments[1]?.entries.find((entry) => entry.kind === "gap")).toMatchObject({ fromSequence: 3, toSequence: 4 });
    expect(body.assessment).toMatchObject({ completeness: "gapped", integrityOk: true });
    // 接缝声明不完整即拒:缺 connectionId、缺 generation 都不得伪造出处。
    const invalid = await harness.inject("POST", `/api/projects/${harness.projectId}/data/recordings/${recordingId}/resume`, { generation: 1 });
    expect(invalid.statusCode).toBe(400);
    const noGeneration = await harness.inject("POST", `/api/projects/${harness.projectId}/data/recordings/${recordingId}/resume`, { connectionId: "conn-sim-1" });
    expect(noGeneration.statusCode).toBe(400);
  });
});
