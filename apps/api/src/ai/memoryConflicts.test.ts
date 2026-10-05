import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApiServer } from "../serverOptions.js";
import { AgentMemoryStore } from "./agentMemory.js";
import { registerAgentMemoryRoutes } from "./agentMemoryRoutes.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.all(cleanups.splice(0).map((cleanup) => cleanup())); });

async function createStore(): Promise<AgentMemoryStore> {
  const directory = await mkdtemp(path.join(tmpdir(), "bim-memory-conflict-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const store = new AgentMemoryStore(directory);
  await store.init();
  return store;
}

function verdictInput(overrides: Partial<Parameters<AgentMemoryStore["recordVerdict"]>[1]>) {
  return {
    proposalFingerprint: "0000000000000001",
    resultFingerprint: "1000000000000001",
    verdict: "confirmed" as const,
    reasonCode: "prediction-within-tolerance",
    rationale: "实测在容差带内",
    ...overrides,
  };
}

describe("Semantica 刀2：记忆冲突检测", () => {
  it("规则① 判定翻供：同 proposalFingerprint 先 confirmed 后 refuted，新判定挂 conflictWith，冲突对登记留痕，不阻断", async () => {
    const store = await createStore();
    await store.recordVerdict("project-1", verdictInput({}));
    const flipped = await store.recordVerdict("project-1", verdictInput({
      resultFingerprint: "1000000000000002",
      verdict: "refuted",
      reasonCode: "prediction-outside-tolerance",
    }));

    expect(flipped.conflictWith).toEqual(["verdict:1000000000000001"]);
    // 窗口语义不变：同 proposalFingerprint 仍覆盖，只剩新判定。
    const verdicts = await store.listVerdicts("project-1");
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0]?.conflictWith).toEqual(["verdict:1000000000000001"]);

    const conflicts = await store.listConflicts("project-1");
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({
      kind: "verdict-polarity",
      topic: "fingerprint:0000000000000001",
      recordId: "verdict:1000000000000002",
      conflictWith: ["verdict:1000000000000001"],
    });
  });

  it("规则② 理由码反转：不同提案同理由码结论相反，标记不阻断；纯重放与不同理由码不误报", async () => {
    const store = await createStore();
    // 纯重放：同提案同判定覆盖，不构成冲突。
    await store.recordVerdict("project-1", verdictInput({}));
    const replay = await store.recordVerdict("project-1", verdictInput({}));
    expect(replay.conflictWith).toBeUndefined();
    expect(await store.listConflicts("project-1")).toEqual([]);

    // 不同提案、同理由码、结论相反 → 理由码语义反转信号。
    const reversed = await store.recordVerdict("project-1", verdictInput({
      proposalFingerprint: "0000000000000002",
      resultFingerprint: "1000000000000003",
      verdict: "refuted",
    }));
    expect(reversed.conflictWith).toEqual(["verdict:1000000000000001"]);
    expect((await store.listConflicts("project-1"))[0]).toMatchObject({ kind: "reason-code-reversal", topic: "code:prediction-within-tolerance" });

    // 不同理由码互不相干。
    const unrelated = await store.recordVerdict("project-1", verdictInput({
      proposalFingerprint: "0000000000000003",
      resultFingerprint: "1000000000000004",
      reasonCode: "golden-anchor-mismatch",
    }));
    expect(unrelated.conflictWith).toBeUndefined();
    expect(await store.listConflicts("project-1")).toHaveLength(1);
  });

  it("规则③ refuted-reassertion：refuted 域的新候选与同域 active 记忆相悖，标记不阻断且候选照常登记", async () => {
    const store = await createStore();
    // 既有判定：提案 A confirmed；同域 active 记忆（主张该方案）。
    await store.recordVerdict("project-1", verdictInput({ proposalFingerprint: "00000000000000aa", resultFingerprint: "10000000000000aa" }));
    const active = await store.addMemoryCandidate("project-1", { content: "方案 A 可用：提升传感器单元利用率", proposalFingerprint: "00000000000000aa" });
    await store.confirmMemory("project-1", active.id, "chief");
    // 翻供：提案 A 被 refuted。
    await store.recordVerdict("project-1", verdictInput({
      proposalFingerprint: "00000000000000aa",
      resultFingerprint: "10000000000000bb",
      verdict: "refuted",
      reasonCode: "prediction-outside-tolerance",
    }));
    // 新候选（refuted 域再主张/反驳记载）与既有 active 记忆同域 → 冲突标记。
    const candidate = await store.addMemoryCandidate("project-1", {
      content: "上轮被内核反驳的方案：00000000000000aa 实测越过容差带",
      proposalFingerprint: "00000000000000aa",
    });
    expect(candidate.status).toBe("pending");
    expect(candidate.conflictWith).toEqual([active.id]);
    const conflicts = await store.listConflicts("project-1");
    const reassertion = conflicts.find((entry) => entry.kind === "refuted-reassertion");
    expect(reassertion).toMatchObject({ topic: "fingerprint:00000000000000aa", recordId: candidate.id, conflictWith: [active.id] });
  });

  it("无 refuted 判定/无同域记忆时不误报；delivery 随行冲突对且不计入注入预算", async () => {
    const store = await createStore();
    await store.recordVerdict("project-1", verdictInput({}));
    const candidate = await store.addMemoryCandidate("project-1", { content: "普通记忆", proposalFingerprint: "0000000000000001" });
    expect(candidate.conflictWith).toBeUndefined();
    expect(await store.listConflicts("project-1")).toEqual([]);

    // 制造一条冲突后看 delivery：conflicts 随行，但 configured/injectionChars/sources 不受影响。
    await store.recordVerdict("project-1", verdictInput({ resultFingerprint: "1000000000000002", verdict: "refuted" }));
    const delivery = await store.loadDelivery("project-1");
    expect(delivery.conflicts).toHaveLength(1);
    expect(delivery.conflicts[0]).toMatchObject({ kind: "verdict-polarity" });
    expect(delivery.injectionChars).toBe(
      delivery.sources.reduce((total, source) => total + source.chars, 0),
      "冲突元数据不计入注入预算",
    );
  });

  it("冲突登记与判定窗口各自滚动封顶，互不挤占", async () => {
    const store = await createStore();
    // 25 条不同提案、同理由码、极性交替：每次反转都检出冲突（单次封顶 4 对），登记封顶 20。
    for (let index = 0; index < 25; index += 1) {
      const fp = `20000000000000${index.toString(16).padStart(2, "0")}`;
      await store.recordVerdict("project-1", verdictInput({
        proposalFingerprint: fp,
        resultFingerprint: `10000000000000${index.toString(16).padStart(2, "0")}`,
        verdict: index % 2 === 0 ? "confirmed" : "refuted",
      }));
    }
    const conflicts = await store.listConflicts("project-1");
    expect(conflicts).toHaveLength(20);
    expect(conflicts[0]?.kind).toBe("reason-code-reversal");
    // verdict 窗口封顶 20（AGENT_VERDICT_MAX_RECORDS）不因冲突登记而变化。
    expect(await store.listVerdicts("project-1")).toHaveLength(20);
  });
});

describe("Semantica 刀2：冲突对 UI 呈现（记忆面板路由）", () => {
  async function routesApp() {
    const directory = await mkdtemp(path.join(tmpdir(), "bim-memory-conflict-routes-"));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const memory = new AgentMemoryStore(directory);
    await memory.init();
    const app = createApiServer();
    cleanups.push(() => app.close());
    app.addHook("preHandler", async (request) => { request.systemUser = { id: "chief", role: "editor" } as never; });
    await registerAgentMemoryRoutes(app, {
      store: { getProject: (projectId: string) => projectId === "project-1" ? ({ id: "project-1" } as never) : undefined },
      memory,
    });
    return { memory, app };
  }

  it("列表返回 conflicts；翻供判定经 store 读回携带 conflictWith 元数据", async () => {
    const { memory, app } = await routesApp();
    await memory.recordVerdict("project-1", verdictInput({}));
    const listed = await app.inject({ method: "GET", url: "/api/projects/project-1/ai/memory" });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toMatchObject({ conflicts: [] });

    await memory.recordVerdict("project-1", verdictInput({ resultFingerprint: "1000000000000002", verdict: "refuted", reasonCode: "prediction-outside-tolerance" }));
    const conflicted = await app.inject({ method: "GET", url: "/api/projects/project-1/ai/memory" });
    const body = conflicted.json() as { conflicts: Array<{ kind: string; topic: string }> };
    expect(body.conflicts).toHaveLength(1);
    expect(body.conflicts[0]).toMatchObject({ kind: "verdict-polarity", topic: "fingerprint:0000000000000001" });
    // 覆盖后的判定本身挂 conflictWith（面板确认制数据面同口径）。
    const verdicts = await memory.listVerdicts("project-1");
    expect(verdicts[0]?.conflictWith).toEqual(["verdict:1000000000000001"]);
  });
});
