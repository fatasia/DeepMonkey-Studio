import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  aiHypothesisProposalFingerprint,
  type AiHypothesisContract,
  type AiVerificationEnvelope,
} from "@bim-studio/contracts";
import { ProvenanceLedgerStore, PROVENANCE_MAX_CHAINS } from "./provenanceLedger.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.all(cleanups.splice(0).map((cleanup) => cleanup())); });

async function createStore(options?: { maxChains?: number; now?: () => Date }): Promise<{ store: ProvenanceLedgerStore; directory: string }> {
  const directory = await mkdtemp(path.join(tmpdir(), "bim-provenance-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const store = new ProvenanceLedgerStore(directory, options);
  await store.init();
  return { store, directory };
}

const HYPOTHESIS: AiHypothesisContract = {
  hypothesisVersion: "1",
  id: "hyp-ledger-1",
  statement: "校准场景中传感器单元利用率低于 0.3",
  targetModel: "t23-conveyor-sensor-agv",
  prediction: { metric: "resource-utilization", resourceId: "sensor-unit", comparator: "less-than", expected: 0.3 },
  tolerance: { absolute: 0.05 },
};

function envelopeOf(overrides: Partial<AiVerificationEnvelope> = {}): AiVerificationEnvelope {
  return {
    proposalFingerprint: aiHypothesisProposalFingerprint(HYPOTHESIS),
    inputFingerprint: "123456789abcdef0",
    resultFingerprint: "23456789abcdef01",
    verdict: "confirmed",
    tolerance: { absolute: 0.05 },
    reasonCode: "prediction-within-tolerance",
    rationale: "假设「传感器利用率低于 0.3」：实测 sensor-unit=0.095238，低于阈值，越过容差带；golden 基准对照一致。",
    engineId: "plant-lite-des",
    goldenHash: "cf20cfbd6e97a617",
    goldenMatch: true,
    generatedAt: "2026-09-28T10:00:00.000Z",
    evidence: [],
    ...overrides,
  };
}

function verifyInput(envelope: AiVerificationEnvelope) {
  return { envelope, contract: HYPOTHESIS, seed: "t23-calibration-2026-09-27", replications: 12 };
}

/** H-C3 验收主链路：落账 → 三跳查询闭环（正例）。 */
describe("ProvenanceLedger（实验档案室）", () => {
  it("落账→三跳查询闭环：假设→运行→判定成链且指纹一致，列表摘要可得", async () => {
    const { store } = await createStore();
    const recorded = await store.recordVerification("project-1", verifyInput(envelopeOf()));

    const trace = await store.trace("project-1", { resultFingerprint: recorded.run.resultFingerprint });
    expect(trace.matched).toBe(true);
    expect(trace.chains).toHaveLength(1);
    const chain = trace.chains[0];
    expect(chain.hypothesis.proposalFingerprint).toBe(recorded.hypothesis.proposalFingerprint);
    expect(chain.hypothesis.metricLocator).toBe("resource-utilization:sensor-unit");
    expect(chain.runs[0].inputFingerprint).toBe("123456789abcdef0");
    expect(chain.runs[0].seed).toBe("t23-calibration-2026-09-27");
    expect(chain.runs[0].goldenHash).toBe("cf20cfbd6e97a617");
    expect(chain.verdicts[0].verdict).toBe("confirmed");
    expect(chain.verdicts[0].reasonCode).toBe("prediction-within-tolerance");
    expect(chain.verdicts[0].tolerance).toEqual({ absolute: 0.05 });
    expect(chain.integrity).toBe("intact");
    expect(chain.edges.map((edge) => edge.relation)).toEqual(["executed", "judged"]);

    const list = await store.listChains("project-1");
    expect(list.chains).toHaveLength(1);
    expect(list.chains[0].runCount).toBe(1);
    expect(list.chains[0].latest?.verdict).toBe("confirmed");
    expect(list.integrity.intact).toBe(true);
  });

  it("只登记未验证：链如实呈现空运行段，不是伪造的已完成链", async () => {
    const { store } = await createStore();
    const contractFingerprint = aiHypothesisProposalFingerprint(HYPOTHESIS);
    await store.recordHypothesis("project-1", { contract: HYPOTHESIS, proposalFingerprint: contractFingerprint });

    const trace = await store.trace("project-1", { proposalFingerprint: contractFingerprint });
    expect(trace.matched).toBe(true);
    expect(trace.chains[0].runs).toEqual([]);
    expect(trace.chains[0].verdicts).toEqual([]);
    expect(trace.chains[0].hypothesis.verifiedAt).toBeUndefined();
  });

  it("无记录如实未命中：零链、matched=false，不伪造", async () => {
    const { store } = await createStore();
    const trace = await store.trace("project-1", { resultFingerprint: "23456789abcdef01" });
    expect(trace.matched).toBe(false);
    expect(trace.chains).toEqual([]);
    expect(trace.integrity.intact).toBe(true);
    const list = await store.listChains("project-1");
    expect(list.chains).toEqual([]);
  });

  it("跨 run 链：同假设两次不同结果运行各成一跳，判定各随其运行", async () => {
    const { store } = await createStore();
    await store.recordVerification("project-1", verifyInput(envelopeOf()));
    await store.recordVerification("project-1", verifyInput(envelopeOf({
      resultFingerprint: "aaaaaaaaaaaaaaaa",
      verdict: "refuted",
      reasonCode: "prediction-outside-tolerance",
      rationale: "实测高于阈值且越过容差带。",
    })));

    const trace = await store.trace("project-1", { proposalFingerprint: aiHypothesisProposalFingerprint(HYPOTHESIS) });
    expect(trace.chains).toHaveLength(1);
    expect(trace.chains[0].runs).toHaveLength(2);
    expect(trace.chains[0].verdicts.map((node) => node.verdict)).toEqual(["confirmed", "refuted"]);
    expect(trace.chains[0].edges.filter((edge) => edge.relation === "executed")).toHaveLength(2);
  });

  it("指纹幂等：同信封重复落账不产生重复节点，判定时点刷新", async () => {
    let tick = 0;
    const { store } = await createStore({ now: () => new Date(Date.parse("2026-09-28T10:00:00.000Z") + (tick++) * 1_000) });
    await store.recordVerification("project-1", verifyInput(envelopeOf()));
    await store.recordVerification("project-1", verifyInput(envelopeOf()));

    const trace = await store.trace("project-1", {});
    expect(trace.chains[0].runs).toHaveLength(1);
    expect(trace.chains[0].verdicts).toHaveLength(1);
    expect(trace.chains[0].verdicts[0].judgedAt).toBe("2026-09-28T10:00:01.000Z");
  });

  it("串行提交纪律回归：并发落账交错零丢失（链内读改写；链外 clone 形态会被本用例证伪）", async () => {
    const { store, directory } = await createStore();
    // 先串行热一次缓存：此后并发提交若各自还能拿到"已提交最新值"，才是链内读改写。
    // 链外形态（先读档/clone 再排队写）在此必然让每个写者基于同一陈旧文档整文件
    // 覆盖——最后落盘者独占文档，先提交者的节点全部蒸发。
    await store.recordHypothesis("project-1", { contract: HYPOTHESIS, proposalFingerprint: aiHypothesisProposalFingerprint(HYPOTHESIS) });
    await Promise.all([
      store.recordVerification("project-1", verifyInput(envelopeOf({ resultFingerprint: "aaaaaaaaaaaaaaaa" }))),
      store.recordVerification("project-1", verifyInput(envelopeOf({
        resultFingerprint: "bbbbbbbbbbbbbbbb",
        verdict: "refuted",
        reasonCode: "prediction-outside-tolerance",
        rationale: "实测高于阈值且越过容差带。",
      }))),
      store.recordReport("project-1", {
        evidenceFingerprint: "cccccccccccccccc",
        label: "并发报告证据",
        proposalFingerprint: aiHypothesisProposalFingerprint(HYPOTHESIS),
        resultFingerprint: "aaaaaaaaaaaaaaaa",
      }),
    ]);
    // 落盘文档为证：两个运行 + 两个判定 + 一个报告全部在档（旧形态最后落盘者只剩自己的节点）。
    const raw = JSON.parse(await readFile(path.join(directory, "provenance-ledger", "project-1", "ledger.json"), "utf8")) as {
      hypotheses: unknown[];
      runs: Array<{ resultFingerprint: string }>;
      verdicts: Array<{ resultFingerprint: string; verdict: string }>;
      reports: Array<{ evidenceFingerprint: string }>;
    };
    expect(raw.hypotheses).toHaveLength(1);
    expect(raw.runs.map((node) => node.resultFingerprint).sort()).toEqual(["aaaaaaaaaaaaaaaa", "bbbbbbbbbbbbbbbb"]);
    expect(raw.verdicts.map((node) => node.verdict).sort()).toEqual(["confirmed", "refuted"]);
    expect(raw.reports.map((node) => node.evidenceFingerprint)).toEqual(["cccccccccccccccc"]);
    // 查询侧同口径：链完整、完整性指纹全部通过（没有被覆盖写撕裂的半链）。
    const trace = await store.trace("project-1", { proposalFingerprint: aiHypothesisProposalFingerprint(HYPOTHESIS) });
    expect(trace.matched).toBe(true);
    expect(trace.chains[0].runs).toHaveLength(2);
    expect(trace.chains[0].reports).toHaveLength(1);
    expect(trace.integrity.intact).toBe(true);
  });

  it("指纹不可篡改：改落盘判定后重启读档，链断如实暴露（不静默修复）", async () => {
    const { store, directory } = await createStore();
    await store.recordVerification("project-1", verifyInput(envelopeOf()));
    const ledgerPath = path.join(directory, "provenance-ledger", "project-1", "ledger.json");
    const document = JSON.parse(await readFile(ledgerPath, "utf8")) as { verdicts: Array<{ verdict: string }> };
    expect(document.verdicts).toHaveLength(1);
    document.verdicts[0].verdict = "refuted";
    await import("node:fs/promises").then((fs) => fs.writeFile(ledgerPath, JSON.stringify(document, null, 2), "utf8"));

    // 新实例模拟服务重启：读回时重算完整性指纹，篡改必须可见。
    const reopened = new ProvenanceLedgerStore(directory);
    await reopened.init();
    const trace = await reopened.trace("project-1", {});
    expect(trace.integrity.intact).toBe(false);
    expect(trace.integrity.brokenNodes).toEqual(["verdict:23456789abcdef01"]);
    expect(trace.chains[0].integrity).toBe("broken");
    expect(trace.chains[0].breaks[0]?.code).toBe("verdict-integrity-mismatch");
    const list = await reopened.listChains("project-1");
    expect(list.chains[0].integrity).toBe("broken");
  });

  it("容量逐出：超过 maxChains 时最旧链及其运行判定一并移除", async () => {
    const { store } = await createStore({ maxChains: 2 });
    for (let index = 0; index < 3; index++) {
      const contract: AiHypothesisContract = { ...HYPOTHESIS, id: `hyp-evict-${index}`, statement: `第 ${index} 号假设：传感器利用率低于 0.3` };
      await store.recordVerification("project-1", {
        envelope: { ...envelopeOf(), proposalFingerprint: aiHypothesisProposalFingerprint(contract), resultFingerprint: `000000000000000${index}` },
        contract,
        seed: "t23-calibration-2026-09-27",
        replications: 12,
      });
    }
    const trace = await store.trace("project-1", {});
    expect(trace.chains).toHaveLength(2);
    const resultFingerprints = trace.chains.flatMap((chain) => chain.runs.map((run) => run.resultFingerprint)).sort();
    expect(resultFingerprints).toEqual(["0000000000000001", "0000000000000002"]);
    expect(trace.chains.every((chain) => chain.integrity === "intact")).toBe(true);
    expect(PROVENANCE_MAX_CHAINS).toBe(200);
  });

  it("报告跳：recordReport 落 Study 证据指纹，链成四跳（含 reported 边）", async () => {
    const { store } = await createStore();
    await store.recordVerification("project-1", verifyInput(envelopeOf()));
    await store.recordReport("project-1", {
      evidenceFingerprint: "beefbeefbeefbeef",
      label: "Study 报告证据",
      proposalFingerprint: aiHypothesisProposalFingerprint(HYPOTHESIS),
      resultFingerprint: "23456789abcdef01",
    });
    const chain = await store.chainByResult("project-1", "23456789abcdef01");
    expect(chain?.reports).toHaveLength(1);
    expect(chain?.reports[0].evidenceFingerprint).toBe("beefbeefbeefbeef");
    expect(chain?.edges.at(-1)).toEqual({ from: "verdict:23456789abcdef01", to: "report:beefbeefbeefbeef", relation: "reported" });
  });

  it("落账文件形状：只存指纹+判定+理由码+摘要，账本不含运行参数原文之外的凭据面", async () => {
    const { store, directory } = await createStore();
    await store.recordVerification("project-1", verifyInput(envelopeOf()));
    const raw = await readFile(path.join(directory, "provenance-ledger", "project-1", "ledger.json"), "utf8");
    const document = JSON.parse(raw) as { schemaVersion: number; hypotheses: Array<{ statementDigest: string }>; verdicts: Array<{ rationaleDigest: string }> };
    expect(document.schemaVersion).toBe(1);
    expect(document.hypotheses[0].statementDigest).toContain("传感器");
    expect(document.verdicts[0].rationaleDigest.length).toBeLessThanOrEqual(301 + 6);
  });
});
