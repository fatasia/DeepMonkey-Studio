import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentCheckpoint } from "@bim-studio/industrial-agent-orchestrator";
import { IndustrialAgentCheckpointStore } from "./industrialAgentCheckpointStore.js";

const directories: string[] = [];
afterEach(async () => Promise.all(directories.splice(0).map((item) => rm(item, { recursive: true, force: true }))));

describe("IndustrialAgentCheckpointStore", () => {
  it("keeps the last durable state after a failed write and retries without leaking uncommitted runs", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "industrial-agent-failed-write-"));
    directories.push(dataDir);
    const store = new IndustrialAgentCheckpointStore(dataDir);
    await store.init();
    const saved = checkpoint();
    await store.save(saved);
    const file = path.join(dataDir, "industrial-agent-checkpoints.json");
    await rename(file, `${file}.saved`);
    await mkdir(file);
    await expect(store.save({ ...saved, revision: 2, status: "completed" })).rejects.toThrow();
    await expect(store.save({ ...saved, id: "uncommitted-run" })).rejects.toThrow();
    expect(await store.get(saved.id)).toEqual(saved);
    expect(await store.get("uncommitted-run")).toBeUndefined();
    await rm(file, { recursive: true });
    await rename(`${file}.saved`, file);
    const next = { ...saved, revision: 3 };
    await store.save(next);
    const recovered = new IndustrialAgentCheckpointStore(dataDir);
    await recovered.init();
    expect(await recovered.get(saved.id)).toEqual(next);
    expect(await recovered.get("uncommitted-run")).toBeUndefined();
  });

  it("captures each queued save independently from later caller mutations", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "industrial-agent-queued-write-"));
    directories.push(dataDir);
    const store = new IndustrialAgentCheckpointStore(dataDir);
    await store.init();
    const first = checkpoint();
    const pending = store.save(first);
    first.objective = "changed after save";
    const second = { ...checkpoint(), id: "run-2" };
    await Promise.all([pending, store.save(second)]);
    expect((await store.get("run-1"))?.objective).not.toBe(first.objective);
    const recovered = new IndustrialAgentCheckpointStore(dataDir);
    await recovered.init();
    expect(await recovered.get("run-2")).toEqual(second);
  });

  it("keeps a waiting choice while pruning old terminal runs and restores it after restart", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "industrial-agent-choice-"));
    directories.push(dataDir);
    const waiting = checkpoint();
    waiting.status = "awaiting-input";
    delete waiting.pendingTool;
    waiting.pendingSelection = { step: 1, question: "选产线", options: [{ id: "a", label: "产线 A" }, { id: "b", label: "产线 B" }] };
    const older = Array.from({ length: 1000 }, (_, id) => ({ ...checkpoint(), id: `old-${id}`, status: "completed", pendingTool: undefined }));
    await writeFile(path.join(dataDir, "industrial-agent-checkpoints.json"), JSON.stringify({ schemaVersion: 1, runs: [...older, waiting] }));
    const first = new IndustrialAgentCheckpointStore(dataDir);
    await first.init(); await first.save({ ...checkpoint(), id: "new" });
    const second = new IndustrialAgentCheckpointStore(dataDir); await second.init();
    expect(await second.get(waiting.id)).toEqual(waiting);
  });
  it("restores an approval checkpoint after a new store instance starts", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "industrial-agent-checkpoint-"));
    directories.push(dataDir);
    const first = new IndustrialAgentCheckpointStore(dataDir);
    await first.init();
    const saved = checkpoint();
    saved.decisions = [{ step: 1, decidedAt: saved.createdAt,
      decision: { kind: "stop", rationale: "done", code: "done", message: "done" },
      execution: { protocol: "responses", requestedModel: "alias", reportedModel: "snapshot", reasoningEffortSent: "high", servedBy: "fallback", failoverCategory: "server" } }];
    await first.save(saved);

    const recovered = new IndustrialAgentCheckpointStore(dataDir);
    await recovered.init();
    expect(await recovered.get("run-1")).toMatchObject({
      status: "awaiting-approval",
      pendingTool: { fingerprint: "scope-1", state: "awaiting-approval" },
      decisions: saved.decisions,
    });
  });
});

function checkpoint(): AgentCheckpoint {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    id: "run-1",
    projectId: "project-1",
    principal: "operator-1",
    objective: "验证设备状态后执行受控操作",
    context: {},
    status: "awaiting-approval",
    budget: { maxSteps: 8, maxDurationMs: 120_000, maxToolCalls: 6 },
    usage: { steps: 1, activeDurationMs: 12, toolCalls: 0 },
    allowedToolIds: ["industrial.control"],
    decisions: [],
    toolRecords: [],
    seenToolFingerprints: [],
    pendingTool: {
      step: 1,
      fingerprint: "scope-1",
      call: { toolId: "industrial.control", arguments: {}, resources: [{ kind: "project", id: "project-1" }] },
      effect: "control",
      state: "awaiting-approval",
    },
    createdAt: now,
    updatedAt: now,
    revision: 1,
  };
}
