import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentCheckpoint } from "@bim-studio/industrial-agent-orchestrator";
import { IndustrialAgentCheckpointStore } from "./industrialAgentCheckpointStore.js";

const directories: string[] = [];
afterEach(async () => Promise.all(directories.splice(0).map((item) => rm(item, { recursive: true, force: true }))));

describe("IndustrialAgentCheckpointStore", () => {
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
    await first.save(checkpoint());

    const recovered = new IndustrialAgentCheckpointStore(dataDir);
    await recovered.init();
    expect(await recovered.get("run-1")).toMatchObject({
      status: "awaiting-approval",
      pendingTool: { fingerprint: "scope-1", state: "awaiting-approval" },
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
