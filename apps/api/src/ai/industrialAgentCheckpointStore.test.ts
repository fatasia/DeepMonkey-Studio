import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentCheckpoint } from "@bim-studio/industrial-agent-orchestrator";
import { IndustrialAgentCheckpointStore } from "./industrialAgentCheckpointStore.js";

const directories: string[] = [];
afterEach(async () => Promise.all(directories.splice(0).map((item) => rm(item, { recursive: true, force: true }))));

describe("IndustrialAgentCheckpointStore", () => {
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
