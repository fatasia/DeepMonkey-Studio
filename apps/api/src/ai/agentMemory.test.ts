import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AgentMemoryLimitError,
  AgentMemoryStore,
  AGENT_MEMORY_MAX_RECORDS,
} from "./agentMemory.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function createStore(options: { maxMemories?: number } = {}): Promise<{ store: AgentMemoryStore; directory: string }> {
  const directory = await mkdtemp(path.join(tmpdir(), "agent-memory-store-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const store = new AgentMemoryStore(directory, options);
  await store.init();
  return { store, directory };
}

function documentPath(directory: string): string {
  return path.join(directory, "agent-memory", "project-1", "memories.json");
}

/** S 级加固切片：账本类存储的链内读改写提交纪律（与 simulationStudyTasks/provenanceLedger 同族对齐）。 */
describe("AgentMemoryStore（串行提交纪律）", () => {
  it("并发写回归：候选/确认/verdict 回灌交错零丢失（链外 clone 形态会被本用例证伪）", async () => {
    const { store, directory } = await createStore();
    // 先串行热一次缓存：此后并发提交若各自仍能拿到"已提交最新值"，才是链内读改写。
    // 链外形态（先读档/clone 再排队写）在此必然让每个写者基于同一陈旧文档整文件
    // 覆盖——最后落盘者独占文档，其余写者的条目全部蒸发。
    const warm = await store.addMemoryCandidate("project-1", { content: "预热条目" });
    const candidates = await Promise.all(
      Array.from({ length: 5 }, (_, index) => store.addMemoryCandidate("project-1", { content: `并发候选 ${index}` })),
    );
    expect(candidates.every((record) => record.status === "pending")).toBe(true);
    await Promise.all([warm, ...candidates].map((record) => store.confirmMemory("project-1", record.id, "chief")));
    await Promise.all(
      Array.from({ length: 3 }, (_, index) =>
        store.recordVerdict("project-1", {
          proposalFingerprint: `000000000000000${index}`,
          resultFingerprint: `100000000000000${index}`,
          verdict: index % 2 === 0 ? "confirmed" : "refuted",
          reasonCode: "prediction-within-tolerance",
          rationale: `并发回灌 ${index}`,
        })),
    );

    // 落盘文档为证：6 条记忆全部在档且全部确认、3 条 verdict 全部回灌。
    const raw = JSON.parse(await readFile(documentPath(directory), "utf8")) as {
      memories: Array<{ id: string; status: string }>;
      verdicts: Array<{ proposalFingerprint: string }>;
    };
    expect(raw.memories).toHaveLength(6);
    expect(raw.memories.every((item) => item.status === "active")).toBe(true);
    expect(raw.verdicts.map((item) => item.proposalFingerprint).sort()).toEqual([
      "0000000000000000", "0000000000000001", "0000000000000002",
    ]);
    // 读侧（面板列表/注入投递）与落盘同口径。
    expect(await store.listMemories("project-1")).toHaveLength(6);
    expect(await store.listVerdicts("project-1")).toHaveLength(3);
  });

  it("容量闸在写链内判定：并发候选超限 fail-closed 拒绝，不超收（照 H-C3b 并发闸证伪模式）", async () => {
    const { store } = await createStore({ maxMemories: 2 });
    const attempts = await Promise.allSettled(
      Array.from({ length: 5 }, (_, index) => store.addMemoryCandidate("project-1", { content: `候选 ${index}` })),
    );
    const fulfilled = attempts.filter((item) => item.status === "fulfilled");
    const rejected = attempts.filter((item) => item.status === "rejected");
    expect(fulfilled).toHaveLength(2);
    expect(rejected).toHaveLength(3);
    for (const item of rejected) {
      expect((item as PromiseRejectedResult).reason).toBeInstanceOf(AgentMemoryLimitError);
    }
    // 链外判定形态下 5 个候选全部通过陈旧计数检查，最终只剩最后落盘者的 1 条；
    // 链内判定保证恰好收满上限且不多收。
    expect(await store.listMemories("project-1")).toHaveLength(2);
  });

  it("并发删除/确认交错：存在性判定以已提交最新文档为准，不误删不误报", async () => {
    const { store } = await createStore();
    const first = await store.addMemoryCandidate("project-1", { content: "保留" });
    const second = await store.addMemoryCandidate("project-1", { content: "待删" });
    await Promise.allSettled([
      store.deleteMemory("project-1", second.id),
      store.confirmMemory("project-1", first.id, "chief"),
      store.updateMemory("project-1", first.id, { content: "更新后的守则记忆" }),
    ]);
    const memories = await store.listMemories("project-1");
    expect(memories.map((item) => item.id)).toEqual([first.id]);
    expect(memories[0]).toMatchObject({ status: "active", content: "更新后的守则记忆", confirmedBy: "chief" });
    await expect(store.deleteMemory("project-1", "mem-missing")).rejects.toMatchObject({ code: "agent-memory-not-found" });
  });

  it("fail-closed 加载过滤不回退：坏行丢弃、健康行保留，后续写入不在坏档上放大脏数据", async () => {
    const { store, directory } = await createStore();
    const kept = await store.addMemoryCandidate("project-1", { content: "健康记忆" });
    await store.recordVerdict("project-1", {
      proposalFingerprint: "0000000000000042",
      resultFingerprint: "1000000000000042",
      verdict: "confirmed",
      reasonCode: "prediction-within-tolerance",
      rationale: "健康结论",
    });
    const filePath = documentPath(directory);
    const document = JSON.parse(await readFile(filePath, "utf8")) as { memories: unknown[]; verdicts: unknown[] };
    document.memories.push({ id: "broken-row", content: 42, status: "not-a-status", createdAt: 7 });
    document.verdicts.push({ proposalFingerprint: 7 });
    await writeFile(filePath, JSON.stringify(document), "utf8");

    // 新实例模拟服务重启：坏行被形状过滤、健康行保留。
    const reopened = new AgentMemoryStore(directory);
    await reopened.init();
    const memories = await reopened.listMemories("project-1");
    expect(memories.map((item) => item.id)).toEqual([kept.id]);
    expect(await reopened.listVerdicts("project-1")).toHaveLength(1);

    // 在过滤后的档上继续写：整文件覆盖以过滤后文档为基线，坏行不得复活。
    await reopened.confirmMemory("project-1", kept.id, "chief");
    const reread = JSON.parse(await readFile(filePath, "utf8")) as { memories: Array<{ id: string }>; verdicts: unknown[] };
    expect(reread.memories.map((item) => item.id)).toEqual([kept.id]);
    expect(reread.verdicts).toHaveLength(1);
  });

  it("容量上限常量契约不回退", () => {
    expect(AGENT_MEMORY_MAX_RECORDS).toBe(100);
  });
});
